import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { DirectusClient, computeDiff, type DiffEntry, type DirectusClientOpts } from "./directus.js";
import http from "node:http";
import { randomUUID } from "node:crypto";
import * as cheerio from "cheerio";

// ── Config ────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3001);
const PREVIEW_PROXY_PORT = Number(process.env.PREVIEW_PROXY_PORT ?? 4322);
// Host browsers use to reach previews. Session is the subdomain.
// e.g. PREVIEW_HOST="localhost:4322" → "abc123.localhost:4322"
const PREVIEW_HOST = process.env.PREVIEW_HOST ?? `localhost:${PREVIEW_PROXY_PORT}`;
// Public MCP URL (what browsers see for review/banner endpoints).
const MCP_PUBLIC_URL = (process.env.MCP_PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS ?? 60 * 60 * 1000);
const PREVIEW_TTL_MS = Number(process.env.PREVIEW_TTL_MS ?? 60 * 60 * 1000);

// Maps Directus collections to the website page that renders them (best-effort
// "jump to preview" links — falls back to "/" for unknown collections).
const COLLECTION_PAGES: Record<string, string[]> = {
  menu_items:       ["/speisekarte", "/"],
  categories:       ["/speisekarte"],
  speisekarte_copy: ["/speisekarte"],
  events:           ["/events", "/"],
  team:             ["/ueber-uns"],
  about:            ["/ueber-uns", "/"],
  ueber_uns_copy:   ["/ueber-uns"],
  faq_items:        ["/faq"],
  faq_copy:         ["/faq"],
  kontakt_copy:     ["/kontakt"],
  opening_hours:    ["/kontakt", "/"],
};

function previewPagesForCollection(collection: string): string[] {
  return COLLECTION_PAGES[collection] ?? ["/"];
}

const ITEM_PK_DESCRIPTION =
  "Exact primary key from read_items/read_item (integer or UUID). Never a title, slug, or placeholder; if you only know a name, call read_items with a filter first, then use data[0].id.";

// ── Session state ─────────────────────────────────────────────────────────────

interface SessionInfo {
  directusUrl: string;
  directusToken?: string;
  directusEmail?: string;
  directusPassword?: string;
  websiteUrl?: string;        // what the preview proxy fetches from
  websitePublicUrl?: string;  // optional display URL (not used internally)
  lastUsed: number;
}

const sessionMap = new Map<string, SessionInfo>();

setInterval(() => {
  const now = Date.now();
  for (const [sid, info] of sessionMap.entries()) {
    if (now - info.lastUsed > SESSION_TTL_MS) sessionMap.delete(sid);
  }
}, 60 * 1000).unref();

// ── Request helpers ───────────────────────────────────────────────────────────

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function getOrCreateSession(req: http.IncomingMessage): { id: string; info: SessionInfo } {
  const id = header(req, "x-session-id") || "default";
  const isNew = !sessionMap.has(id);
  let info = sessionMap.get(id);
  if (!info) {
    info = { directusUrl: "", lastUsed: Date.now() };
    sessionMap.set(id, info);
  }
  info.lastUsed = Date.now();

  const dUrl  = header(req, "x-directus-url");      if (dUrl)  info.directusUrl      = dUrl;
  const dTok  = header(req, "x-directus-token");    if (dTok  !== undefined) info.directusToken    = dTok;
  const dMail = header(req, "x-directus-email");    if (dMail !== undefined) info.directusEmail    = dMail;
  const dPass = header(req, "x-directus-password"); if (dPass !== undefined) info.directusPassword = dPass;
  const wUrl  = header(req, "x-website-url");       if (wUrl)  info.websiteUrl       = wUrl;
  const wPub  = header(req, "x-website-public-url");if (wPub)  info.websitePublicUrl = wPub;
  if (isNew) {
    process.stderr.write(`[session] new ${id} directus=${info.directusUrl} website=${info.websiteUrl}\n`);
  }
  return { id, info };
}

function makeClient(info: SessionInfo): DirectusClient {
  const opts: DirectusClientOpts = {
    url:      info.directusUrl      || process.env.DIRECTUS_URL || "http://localhost:8055",
    token:    info.directusToken    ?? process.env.DIRECTUS_TOKEN,
    email:    info.directusEmail    ?? process.env.DIRECTUS_EMAIL,
    password: info.directusPassword ?? process.env.DIRECTUS_PASSWORD,
  };
  return new DirectusClient(opts);
}

// ── Preview store ─────────────────────────────────────────────────────────────

interface PreviewEntry {
  session_id: string;
  action: "create" | "update" | "delete" | "update_singleton";
  collection: string;
  id?: string | number;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  diff?: DiffEntry[];
  data?: Record<string, unknown>;
}

const previewStore = new Map<string, { entry: PreviewEntry; timer: ReturnType<typeof setTimeout> }>();

function storePreview(entry: PreviewEntry): string {
  const token = randomUUID();
  const timer = setTimeout(() => previewStore.delete(token), PREVIEW_TTL_MS);
  previewStore.set(token, { entry, timer });
  return token;
}

function previewsForSession(sessionId: string): { token: string; entry: PreviewEntry }[] {
  const out: { token: string; entry: PreviewEntry }[] = [];
  for (const [token, { entry }] of previewStore.entries()) {
    if (entry.session_id === sessionId) out.push({ token, entry });
  }
  return out;
}

function buildPreviewResponse(token: string, entry: PreviewEntry): string {
  const review_url = `${MCP_PUBLIC_URL}/sessions/${entry.session_id}/review/${token}`;
  const diffSummary = entry.diff && entry.diff.length > 0
    ? entry.diff.map((d) => `  ${d.field}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`).join("\n")
    : entry.after
      ? `  data: ${JSON.stringify(entry.after)}`
      : "";
  return [
    `Staged (not yet written): ${entry.action} on ${entry.collection}${entry.id != null ? ` #${entry.id}` : ""}.`,
    ...(diffSummary ? [`Changes:\n${diffSummary}`] : []),
    `preview_token: ${token}`,
    ``,
    `If you still have more changes to stage, call the next write tool now — do NOT pause to ask the user yet.`,
    `Only after ALL changes are staged, show the user this link (and no other URLs):`,
    `  Review all changes: ${review_url}`,
    `The review page itself has a link to the live preview — never share that URL directly.`,
    `Then ask the user to confirm or discard. Use confirm_all_previews / discard_all_previews for bulk, or confirm_preview / discard_preview per token.`,
  ].join("\n");
}

function buildBulkPreviewResponse(staged: { token: string; entry: PreviewEntry }[]): string {
  if (!staged.length) return "Nothing to stage.";
  const first = staged[0]!;
  const sessionId = first.entry.session_id;
  const review_url = `${MCP_PUBLIC_URL}/sessions/${sessionId}/review/${first.token}`;

  const lines = staged.map(({ token, entry }) => {
    const diff = entry.diff?.map((d) => `${d.field}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`).join(", ") ?? "";
    return `  - ${entry.collection}#${entry.id}${diff ? `  (${diff})` : ""}  token: ${token}`;
  }).join("\n");

  return [
    `Staged ${staged.length} change${staged.length === 1 ? "" : "s"} (one preview per item):`,
    lines,
    ``,
    `If you still have more changes to stage, call the next write tool now — do NOT pause to ask the user yet.`,
    `Only after ALL changes are staged, show the user this link (and no other URLs):`,
    `  Review all changes: ${review_url}`,
    `The review page itself has a link to the live preview — never share that URL directly.`,
    `Then ask the user to confirm or discard. Use confirm_all_previews / discard_all_previews for bulk.`,
  ].join("\n");
}

// ── HTML rewriting ────────────────────────────────────────────────────────────
//
// The proxy fetches the customer's website and inspects elements tagged with
// data-cms-collection / data-cms-id / data-cms-field. For each staged change
// in the session we replace the rendered content with the staged value.
//
// Items can be marked at two levels:
//   <article data-cms-collection="menu_items" data-cms-id="42">
//     <p data-cms-field="name">Tomato Soup</p>
//   </article>
// or with the collection on the leaf:
//   <p data-cms-collection="menu_items" data-cms-id="42" data-cms-field="name">…</p>
//
// We resolve the effective collection/id by walking up the DOM.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function effectiveAttr($: any, el: any, name: string): string | undefined {
  const $el = $(el);
  const own = $el.attr(name);
  if (own) return own;
  return $el.closest(`[${name}]`).attr(name) || undefined;
}

function applyPreviewsToHtml(html: string, sessionId: string): string {
  const entries = previewsForSession(sessionId).map((p) => p.entry);
  if (!entries.length) return html;

  const $ = cheerio.load(html);
  let totalApplied = 0;

  for (const entry of entries) {
    const col = entry.collection;
    const colSel = `[data-cms-collection="${col}"]`;
    let appliedForEntry = 0;

    if (entry.action === "create") {
      process.stderr.write(`[rewrite] session=${sessionId} skip create on ${col} (cannot insert)\n`);
      continue;
    }

    if (entry.action === "delete" && entry.id != null) {
      const id = String(entry.id);
      $(`${colSel}[data-cms-id="${id}"]:not([data-cms-field])`).each((_i: number, el: unknown) => {
        $(el as never).attr("style", ($(el as never).attr("style") || "") + ";opacity:.4;text-decoration:line-through");
        appliedForEntry++;
      });
      process.stderr.write(`[rewrite] session=${sessionId} delete ${col}#${id}: ${appliedForEntry} element(s) marked\n`);
      totalApplied += appliedForEntry;
      continue;
    }

    // For update_bulk and partial-data updates we don't have a per-field diff
    // — synthesize one from the `data` payload so rewriting still works.
    const diff: DiffEntry[] = (entry.diff && entry.diff.length > 0)
      ? entry.diff
      : Object.entries(entry.data ?? {}).map(([field, after]) => ({ field, before: undefined, after }));
    process.stderr.write(`[rewrite]   entry ${entry.action} ${col} id=${entry.id ?? "*"} fields=[${diff.map((d) => d.field).join(",")}]\n`);
    for (const d of diff) {
      const fieldSel = `[data-cms-field="${d.field}"]`;
      const candidates = $(fieldSel);
      let appliedForField = 0;
      candidates.each((_i: number, el: unknown) => {
        const elCol = effectiveAttr($, el, "data-cms-collection");
        if (elCol !== col) return;

        if (entry.action !== "update_singleton") {
          if (entry.id == null) return;
          const elId = effectiveAttr($, el, "data-cms-id");
          if (elId !== String(entry.id)) return;
        }

        if (d.after == null) {
          $(el as never).text("");
          appliedForField++;
        } else if (typeof d.after === "string" || typeof d.after === "number" || typeof d.after === "boolean") {
          $(el as never).text(String(d.after));
          appliedForField++;
        }
      });
      process.stderr.write(`[rewrite] session=${sessionId} ${entry.action} ${col}.${d.field}: ${appliedForField}/${candidates.length} candidates matched\n`);
      appliedForEntry += appliedForField;
    }
    totalApplied += appliedForEntry;
  }

  process.stderr.write(`[rewrite] session=${sessionId} ${entries.length} entries → ${totalApplied} element(s) modified\n`);
  return $.html();
}

// ── Review page + helpers ─────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type StoredPreview = PreviewEntry & { preview_token: string };

function renderEntryCard(p: StoredPreview, highlighted: boolean, previewBaseUrl: string): string {
  const actionLabel: Record<string, string> = {
    create: "Neuer Eintrag", update: "Änderung",
    update_singleton: "Aktualisierung", delete: "Löschung",
  };
  const actionClass: Record<string, string> = {
    create: "label-create", update: "label-update",
    update_singleton: "label-update", delete: "label-delete",
  };
  const diffRows = p.diff && p.diff.length > 0
    ? `<table style="margin-top:1rem">
        <thead><tr><th>Feld</th><th>Vorher</th><th>Nachher</th></tr></thead>
        <tbody>${p.diff.map((d) => `
          <tr>
            <td style="font-family:monospace">${escHtml(d.field)}</td>
            <td class="before">${escHtml(JSON.stringify(d.before) ?? "–")}</td>
            <td class="after">${escHtml(JSON.stringify(d.after) ?? "–")}</td>
          </tr>`).join("")}
        </tbody>
      </table>`
    : p.after
      ? `<pre style="margin-top:1rem;font-size:.8rem;overflow:auto;background:#f3f1ec;padding:1rem;border-radius:4px">${escHtml(JSON.stringify(p.after, null, 2))}</pre>`
      : "";

  const jumpUrl = `${previewBaseUrl}${previewPagesForCollection(p.collection)[0]}?pb_focus=${encodeURIComponent(p.preview_token)}`;

  return `
  <div class="card${highlighted ? " card-highlight" : ""}">
    <div style="display:flex;align-items:center;gap:.75rem;flex-wrap:wrap">
      <span class="label ${escHtml(actionClass[p.action] ?? "label-update")}">${escHtml(actionLabel[p.action] ?? p.action)}</span>
      <strong>${escHtml(p.collection)}${p.id != null ? ` <span style="color:#6b7280">#${escHtml(String(p.id))}</span>` : ""}</strong>
      <div style="margin-left:auto;display:flex;gap:.5rem">
        <a href="${escHtml(jumpUrl)}" class="btn btn-jump btn-sm" target="_blank" rel="noopener">↗ Im Vorschau</a>
        <button class="btn btn-confirm btn-sm" data-confirm="${escHtml(p.preview_token)}">✓ Übernehmen</button>
        <button class="btn btn-discard btn-sm" data-discard="${escHtml(p.preview_token)}">✗ Verwerfen</button>
      </div>
    </div>
    ${diffRows}
    <div class="status" id="s-${escHtml(p.preview_token)}" style="display:none;margin-top:.75rem"></div>
  </div>`;
}

function buildReviewPage(sessionId: string, focusToken: string, allPreviews: StoredPreview[]): string {
  const previewBaseUrl = `http://${sessionId}.${PREVIEW_HOST}`;
  const found   = allPreviews.length > 0;
  const hasMany = allPreviews.length > 1;
  const apiBase = `/sessions/${encodeURIComponent(sessionId)}`;

  const cards = found
    ? allPreviews.map((p) => renderEntryCard(p, p.preview_token === focusToken, previewBaseUrl)).join("")
    : `<div class="card"><p style="color:#6b7280">Vorschau nicht gefunden oder abgelaufen.</p></div>`;

  const bulkBar = hasMany ? `
  <div class="card" style="display:flex;gap:.75rem;align-items:center;flex-wrap:wrap">
    <strong style="font-size:.9rem">${allPreviews.length} Änderungen gesamt</strong>
    <div style="margin-left:auto;display:flex;gap:.5rem">
      <button class="btn btn-confirm" id="confirm-all">✓ Alle übernehmen</button>
      <button class="btn btn-discard" id="discard-all">✗ Alle verwerfen</button>
    </div>
    <div class="status" id="s-all" style="display:none;width:100%"></div>
  </div>` : "";

  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Vorschau überprüfen</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#f9f7f4;color:#1a1816;padding:2rem;max-width:920px;margin:0 auto}
    h1{font-size:1.25rem;font-weight:700;margin-bottom:.25rem}
    .meta{color:#6b7280;font-size:.8rem;margin-bottom:1.5rem}
    .card{background:#fff;border:1px solid #e5e1da;border-radius:6px;padding:1.25rem 1.5rem;margin-bottom:1rem;box-shadow:0 1px 3px rgba(0,0,0,.06)}
    .card-highlight{border-color:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.15)}
    .label{display:inline-block;padding:.2rem .6rem;border-radius:99px;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
    .label-create{background:#dcfce7;color:#16a34a}
    .label-update{background:#fef9c3;color:#ca8a04}
    .label-delete{background:#fee2e2;color:#dc2626}
    table{width:100%;border-collapse:collapse;font-size:.85rem}
    th{text-align:left;padding:.5rem .75rem;background:#f3f1ec;font-weight:600;border:1px solid #e5e1da}
    td{padding:.5rem .75rem;border:1px solid #e5e1da;vertical-align:top}
    .before{color:#dc2626;text-decoration:line-through;background:#fef2f2;font-family:monospace}
    .after{color:#16a34a;background:#f0fdf4;font-weight:600;font-family:monospace}
    .btn{display:inline-flex;align-items:center;padding:.55rem 1.1rem;border-radius:4px;font-weight:600;font-size:.875rem;cursor:pointer;border:none;text-decoration:none;transition:opacity 150ms}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    .btn-sm{padding:.3rem .75rem;font-size:.8rem}
    .btn-confirm{background:#16a34a;color:#fff}.btn-confirm:hover:not(:disabled){background:#15803d}
    .btn-discard{background:#dc2626;color:#fff}.btn-discard:hover:not(:disabled){background:#b91c1c}
    .btn-preview{background:#1a1816;color:#fff}.btn-preview:hover{background:#374151}
    .btn-jump{background:#2563eb;color:#fff}.btn-jump:hover{background:#1d4ed8}
    .status{padding:.6rem .9rem;border-radius:4px;font-weight:600;font-size:.85rem}
    .ok{background:#dcfce7;color:#16a34a}
    .err{background:#fee2e2;color:#dc2626}
    .neutral{background:#f3f4f6;color:#374151}
    a.btn{display:inline-flex}
  </style>
</head>
<body>
  <div style="display:flex;align-items:baseline;gap:1rem;margin-bottom:1.5rem;flex-wrap:wrap">
    <h1>Vorschau überprüfen</h1>
    <a href="${escHtml(previewBaseUrl)}" class="btn btn-preview" target="_blank" style="font-size:.8rem;padding:.35rem .9rem">Live-Vorschau ↗</a>
  </div>
  ${bulkBar}
  ${cards}
  <script>
    const API = ${JSON.stringify(apiBase)};
    async function act(url, method, statusId, okMsg, okClass) {
      const el = document.getElementById(statusId);
      const r = await fetch(url, { method });
      if (el) {
        el.style.display = 'block';
        el.className = 'status ' + (r.ok ? (okClass || 'ok') : 'err');
        el.textContent = r.ok ? okMsg : 'Fehler (' + r.status + ')';
      }
    }
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-confirm],button[data-discard],#confirm-all,#discard-all');
      if (!btn || btn.disabled) return;
      btn.disabled = true;
      if (btn.id === 'confirm-all') {
        const tokens = ${JSON.stringify(allPreviews.map((p) => p.preview_token))};
        await Promise.all(tokens.map(t => fetch(API + '/confirm/' + t, { method: 'POST' })));
        const el = document.getElementById('s-all');
        if (el) { el.style.display='block'; el.className='status ok'; el.textContent='✓ Alle Änderungen übernommen.'; }
      } else if (btn.id === 'discard-all') {
        const tokens = ${JSON.stringify(allPreviews.map((p) => p.preview_token))};
        await Promise.all(tokens.map(t => fetch(API + '/preview/' + t, { method: 'DELETE' })));
        const el = document.getElementById('s-all');
        if (el) { el.style.display='block'; el.className='status neutral'; el.textContent='✗ Alle Änderungen verworfen.'; }
      } else if (btn.dataset.confirm) {
        await act(API + '/confirm/' + btn.dataset.confirm, 'POST', 's-' + btn.dataset.confirm, '✓ Übernommen und gespeichert.', 'ok');
      } else if (btn.dataset.discard) {
        await act(API + '/preview/' + btn.dataset.discard, 'DELETE', 's-' + btn.dataset.discard, '✗ Verworfen.', 'neutral');
      }
    });
  </script>
</body>
</html>`;
}

// ── Banner injection ──────────────────────────────────────────────────────────
//
// Injected into the customer's HTML response by the preview proxy. Highlights
// changed elements and provides confirm/discard UI. The injected MCP URL
// already includes the session prefix, so all callbacks are auto-scoped.

function buildBannerInjection(mcpUrlWithSession: string): string {
  const mcp = JSON.stringify(mcpUrlWithSession);
  return `<style>
#pb-root{position:fixed;bottom:0;left:0;right:0;z-index:9999;box-shadow:0 -4px 24px rgba(0,0,0,.12)}
#pb-float{position:fixed;z-index:9998;display:none;align-items:center;gap:4px;background:rgba(15,15,15,.9);border-radius:6px;padding:4px 6px;box-shadow:0 2px 10px rgba(0,0,0,.45);pointer-events:auto}
.pb-fl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:rgba(255,255,255,.6);padding:0 4px;white-space:nowrap}
.pb-fb{border:none;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px;font-weight:700;color:#fff;white-space:nowrap;line-height:1.4}
.pb-fb:hover{opacity:.82}.pb-fc{background:#16a34a}.pb-fd{background:#dc2626}
.pb-mark{background:#fef08a!important;color:#78350f!important;outline:3px solid #d97706!important;outline-offset:2px!important;border-radius:3px!important;padding:1px 4px!important;margin:0 2px!important;-webkit-box-decoration-break:clone;box-decoration-break:clone;position:relative;z-index:1;cursor:pointer;display:inline;font-weight:600!important;animation:pb-pulse 2s ease-in-out infinite}
.pb-mark[data-pb-action=create]{background:#bbf7d0!important;color:#14532d!important;outline-color:#16a34a!important;animation-name:pb-pulse-c}
.pb-mark[data-pb-action=update_singleton]{background:#bfdbfe!important;color:#1e3a8a!important;outline-color:#2563eb!important;animation-name:pb-pulse-s}
.pb-mark[data-pb-action=delete]{background:#fecaca!important;color:#7f1d1d!important;outline-color:#dc2626!important;text-decoration:line-through!important;animation-name:pb-pulse-d}
.pb-mark:hover{filter:brightness(1.06)}
.pb-anchor{outline:2px dashed #d97706!important;outline-offset:5px!important;border-radius:3px!important;position:relative;z-index:1;cursor:pointer;animation:pb-pulse 2s ease-in-out infinite}
.pb-anchor[data-pb-action=create]{outline-color:#16a34a!important;animation-name:pb-pulse-c}
.pb-anchor[data-pb-action=update_singleton]{outline-color:#2563eb!important;animation-name:pb-pulse-s}
.pb-anchor[data-pb-action=delete]{outline-color:#dc2626!important;animation-name:pb-pulse-d}
.pb-field{outline:3px solid #d97706!important;outline-offset:3px!important;border-radius:3px!important;background-color:rgba(254,240,138,.22)!important;position:relative;z-index:1;cursor:pointer;animation:pb-pulse 2s ease-in-out infinite}
.pb-field[data-pb-anchor]{outline-style:dashed!important;background-color:transparent!important}
.pb-field[data-pb-action=create]{outline-color:#16a34a!important;background-color:rgba(187,247,208,.28)!important;animation-name:pb-pulse-c}
.pb-field[data-pb-action=update_singleton]{outline-color:#2563eb!important;background-color:rgba(191,219,254,.28)!important;animation-name:pb-pulse-s}
.pb-field[data-pb-action=delete]{outline-color:#dc2626!important;background-color:rgba(254,202,202,.28)!important;text-decoration:line-through!important;animation-name:pb-pulse-d}
@keyframes pb-pulse{0%,100%{box-shadow:0 0 0 1px rgba(217,119,6,.4),0 2px 8px rgba(0,0,0,.12)}50%{box-shadow:0 0 0 5px rgba(217,119,6,.4),0 2px 16px rgba(0,0,0,.22)}}
@keyframes pb-pulse-c{0%,100%{box-shadow:0 0 0 1px rgba(22,163,74,.4),0 2px 8px rgba(0,0,0,.12)}50%{box-shadow:0 0 0 5px rgba(22,163,74,.4),0 2px 16px rgba(0,0,0,.22)}}
@keyframes pb-pulse-s{0%,100%{box-shadow:0 0 0 1px rgba(37,99,235,.4),0 2px 8px rgba(0,0,0,.12)}50%{box-shadow:0 0 0 5px rgba(37,99,235,.4),0 2px 16px rgba(0,0,0,.22)}}
@keyframes pb-pulse-d{0%,100%{box-shadow:0 0 0 1px rgba(220,38,38,.4),0 2px 8px rgba(0,0,0,.12)}50%{box-shadow:0 0 0 5px rgba(220,38,38,.4),0 2px 16px rgba(0,0,0,.22)}}
@keyframes pb-p{0%,100%{opacity:1}50%{opacity:.35}}
</style>
<div id="pb-root"></div>
<div id="pb-float"><span class="pb-fl" id="pb-fl"></span><button class="pb-fb pb-fc" id="pb-fc">✓ Übernehmen</button><button class="pb-fb pb-fd" id="pb-fd">✗ Verwerfen</button></div>
<script>
(function(){
  if(window.__pbLoaded)return;
  window.__pbLoaded=true;

  var MCP=${mcp};
  var previews=[],open=false,bound=false,hlBound=false,curToken=null,pbFocusDone=false,hlIndex=-1;
  var pbFloat,pbFl,pbFc,pbFd;

  var ACT={create:'Neu',update:'Änderung',update_singleton:'Aktualisierung',delete:'Löschung'};
  var COL={create:{bg:'#dcfce7',fg:'#16a34a'},update:{bg:'#fef9c3',fg:'#92400e'},update_singleton:{bg:'#dbeafe',fg:'#1e40af'},delete:{bg:'#fee2e2',fg:'#dc2626'}};

  function getDom(){
    pbFloat=document.getElementById('pb-float');
    pbFl=document.getElementById('pb-fl');
    pbFc=document.getElementById('pb-fc');
    pbFd=document.getElementById('pb-fd');
    if(pbFc)pbFc.onclick=async function(){
      if(!curToken)return;
      pbFc.disabled=true;
      await fetch(MCP+'/confirm/'+curToken,{method:'POST'}).catch(Object);
      pbFc.disabled=false;
      hideFloat();load();
    };
    if(pbFd)pbFd.onclick=async function(){
      if(!curToken)return;
      pbFd.disabled=true;
      await fetch(MCP+'/preview/'+curToken,{method:'DELETE'}).catch(Object);
      pbFd.disabled=false;
      hideFloat();load();
    };
  }

  function showFloat(el,token,action){
    if(!pbFloat||!pbFl)return;
    curToken=token;
    pbFl.textContent=el.dataset.pbAnchor?'Änderung hier':(ACT[action]||action);
    var r=el.getBoundingClientRect();
    pbFloat.style.top=Math.max(4,r.top+4)+'px';
    pbFloat.style.right=Math.max(4,window.innerWidth-r.right+4)+'px';
    pbFloat.style.left='auto';
    pbFloat.style.display='flex';
  }
  function hideFloat(){if(pbFloat)pbFloat.style.display='none';curToken=null;}

  function cssEscapeStr(s){return String(s).replace(/[\\"'\\\\]/g,function(c){return'\\\\'+c;});}

  /* Mark matching elements so the user can see WHERE things changed.
     The actual content has already been replaced server-side. */
  function markByAttributes(p){
    var col=p.collection;
    var token=p.preview_token;
    var action=p.action;
    var rawId=p.id!=null?String(p.id):null;
    var matchIds=p.ids?p.ids.reduce(function(m,id){m[String(id)]=true;return m;},{}):null;
    var needId=action!=='update_singleton';

    function effectiveCollection(el){
      var own=el.getAttribute('data-cms-collection');
      if(own)return own;
      var anc=el.closest('[data-cms-collection]');
      return anc?anc.getAttribute('data-cms-collection'):null;
    }
    function inScope(el){
      if(!needId)return true;
      if(matchIds){
        var ownId=el.getAttribute('data-cms-id');
        if(ownId)return!!matchIds[ownId];
        var anc=el.closest('[data-cms-collection="'+cssEscapeStr(col)+'"][data-cms-id]');
        return!!anc&&!!matchIds[anc.getAttribute('data-cms-id')];
      }
      if(!rawId)return true;
      var ownId=el.getAttribute('data-cms-id');
      if(ownId)return ownId===rawId;
      var anc=el.closest('[data-cms-collection="'+cssEscapeStr(col)+'"][data-cms-id]');
      return!!anc&&anc.getAttribute('data-cms-id')===rawId;
    }
    function tag(el,isAnchor){
      el.classList.add('pb-field');
      el.setAttribute('data-pb-token',token);
      el.setAttribute('data-pb-action',action);
      if(isAnchor)el.setAttribute('data-pb-anchor','1');
    }

    var marked=0;
    var fields=[];
    if(p.diff&&p.diff.length)p.diff.forEach(function(d){fields.push(d.field);});
    fields.forEach(function(field){
      var sel='[data-cms-field="'+cssEscapeStr(field)+'"]';
      document.querySelectorAll(sel).forEach(function(el){
        if(effectiveCollection(el)!==col)return;
        if(!inScope(el))return;
        if(el.classList.contains('pb-field'))return;
        tag(el,false);marked++;
      });
    });

    if(marked===0){
      if(matchIds){
        Object.keys(matchIds).forEach(function(id){
          document.querySelectorAll('[data-cms-collection="'+cssEscapeStr(col)+'"][data-cms-id="'+cssEscapeStr(id)+'"]:not([data-cms-field])').forEach(function(el){
            if(el.classList.contains('pb-field'))return;
            tag(el,true);marked++;
          });
        });
      } else {
        var anchorSel=needId&&rawId
          ?'[data-cms-collection="'+cssEscapeStr(col)+'"][data-cms-id="'+cssEscapeStr(rawId)+'"]:not([data-cms-field])'
          :'[data-cms-collection="'+cssEscapeStr(col)+'"]:not([data-cms-field])';
        document.querySelectorAll(anchorSel).forEach(function(el){
          if(el.classList.contains('pb-field'))return;
          tag(el,true);marked++;
        });
      }
    }
    return marked;
  }

  function clearHighlights(){
    document.querySelectorAll('.pb-field').forEach(function(el){
      el.classList.remove('pb-field');
      el.removeAttribute('data-pb-token');
      el.removeAttribute('data-pb-action');
      el.removeAttribute('data-pb-anchor');
    });
  }

  function applyHighlights(){
    clearHighlights();
    hlIndex=-1;
    if(!previews.length){hideFloat();return;}
    previews.forEach(function(p){ markByAttributes(p); });
    if(hlBound)return;
    hlBound=true;
    document.addEventListener('mouseover',function(e){
      var el=e.target&&e.target.closest&&e.target.closest('.pb-field');
      if(el)showFloat(el,el.dataset.pbToken,el.dataset.pbAction);
    });
    document.addEventListener('mouseout',function(e){
      var rt=e.relatedTarget;
      if(rt&&rt.closest&&(rt.closest('.pb-field')||(pbFloat&&(rt===pbFloat||pbFloat.contains(rt)))))return;
      hideFloat();
    });
    if(pbFloat)pbFloat.addEventListener('mouseout',function(e){
      var rt=e.relatedTarget;
      if(rt&&(rt.closest&&rt.closest('.pb-field')||pbFloat.contains(rt)))return;
      hideFloat();
    });
  }

  function markedTokens(){
    var seen={},order=[];
    document.querySelectorAll('.pb-field').forEach(function(s){
      var t=s.dataset.pbToken;
      if(!seen[t]){seen[t]=s;order.push(t);}
    });
    return order.map(function(t){return seen[t];});
  }

  function navigateHighlights(dir){
    var els=markedTokens();
    if(!els.length)return;
    hlIndex=(hlIndex+dir+els.length)%els.length;
    var el=els[hlIndex];
    el.scrollIntoView({behavior:'smooth',block:'center'});
    showFloat(el,el.dataset.pbToken,el.dataset.pbAction||'update');
    render();
  }

  function escH(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function diffText(p){
    if(p.diff&&p.diff.length)return p.diff.map(function(d){return d.field+': '+JSON.stringify(d.before)+' → '+JSON.stringify(d.after);}).join(' · ');
    return p.after?JSON.stringify(p.after).slice(0,120):'';
  }
  function badge(p){var c=COL[p.action]||COL.update;return'<span style="background:'+c.bg+';color:'+c.fg+';padding:2px 8px;border-radius:99px;font-size:11px;font-weight:700;text-transform:uppercase;white-space:nowrap">'+(ACT[p.action]||p.action)+'</span>';}

  function buildHTML(){
    var n=previews.length,lbl=n===1?'1 Änderung':n+' Änderungen';
    var hlN=markedTokens().length;
    var navBtn='padding:3px 10px;background:rgba(120,53,15,.12);border:1px solid rgba(120,53,15,.35);border-radius:4px;cursor:pointer;font-size:13px;font-weight:700;color:#78350f;line-height:1';
    var navHtml=hlN>0
      ?'<span style="display:inline-flex;align-items:center;gap:3px;margin-left:6px">'
        +'<button data-pb="prev" style="'+navBtn+'">←</button>'
        +'<span style="font-size:11px;font-weight:700;color:#78350f;min-width:34px;text-align:center;padding:0 2px">'
          +(hlIndex>=0?(hlIndex+1)+' / '+hlN:'↕ '+hlN)
        +'</span>'
        +'<button data-pb="next" style="'+navBtn+'">→</button>'
        +'</span>'
      :'';
    var rows=open?'<div style="background:#fffbeb;border-top:2px solid #fcd34d;max-height:280px;overflow-y:auto">'
      +previews.map(function(p){
        var otherPages=(p.preview_pages||[]).filter(function(pg){return pg!==location.pathname;});
        var jumpLink=otherPages.map(function(pg){
          var lbl=pg==='/'?'Startseite':pg.slice(1).charAt(0).toUpperCase()+pg.slice(2);
          return'<a href="'+escH(pg)+'?pb_focus='+escH(p.preview_token)+'" style="padding:3px 10px;background:#2563eb;color:#fff;border-radius:3px;font-size:12px;font-weight:600;text-decoration:none;white-space:nowrap;display:inline-block">↗ '+escH(lbl)+'</a>';
        }).join('');
        return'<div style="display:flex;align-items:center;gap:10px;padding:9px 20px;border-bottom:1px solid #fef3c7;font-size:13px;flex-wrap:wrap">'
          +badge(p)+'<span style="font-weight:600;color:#1a1816;white-space:nowrap">'+escH(p.collection)+(p.id!=null?' #'+escH(String(p.id)):p.ids?' ('+p.ids.length+' items)':'')+'</span>'
          +'<span style="color:#6b7280;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0">'+escH(diffText(p))+'</span>'
          +jumpLink
          +'<button data-pb="confirm-one" data-token="'+escH(p.preview_token)+'" style="padding:3px 10px;background:#16a34a;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:12px;font-weight:600">✓ Übernehmen</button>'
          +'<button data-pb="discard-one" data-token="'+escH(p.preview_token)+'" style="padding:3px 10px;background:#dc2626;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:12px;font-weight:600">✗ Verwerfen</button>'
          +'</div>';}).join('')+'</div>':'';
    return'<style>@keyframes pb-p{0%,100%{opacity:1}50%{opacity:.35}}</style>'+rows
      +'<div style="background:#fbbf24;border-top:2px solid #f59e0b;padding:8px 20px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">'
      +'<span style="display:inline-flex;align-items:center;gap:8px;font-weight:700;font-size:13px;color:#78350f">'
      +'<span style="width:8px;height:8px;border-radius:50%;background:#92400e;animation:pb-p 1.5s ease-in-out infinite;flex-shrink:0"></span>'
      +'Vorschau — '+escH(lbl)+' staged</span>'
      +navHtml
      +'<button data-pb="toggle" style="padding:4px 10px;background:transparent;border:1px solid rgba(120,53,15,.4);border-radius:99px;cursor:pointer;font-size:12px;font-weight:600;color:#78350f">'+(open?'Schließen':'Details anzeigen')+'</button>'
      +'<div style="margin-left:auto;display:flex;gap:8px">'
      +'<button data-pb="confirm-all" style="padding:5px 14px;background:#16a34a;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:600">✓ Alle übernehmen</button>'
      +'<button data-pb="discard-all" style="padding:5px 14px;background:#dc2626;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:600">✗ Alle verwerfen</button>'
      +'</div></div>';
  }

  async function onBannerClick(e){
    var btn=e.target.closest('[data-pb]');
    if(!btn||btn.disabled)return;
    btn.disabled=true;
    var a=btn.dataset.pb,t=btn.dataset.token;
    if(a==='toggle'){open=!open;render();return;}
    if(a==='prev'){navigateHighlights(-1);return;}
    if(a==='next'){navigateHighlights(1);return;}
    if(a==='confirm-all')await Promise.all(previews.map(function(p){return fetch(MCP+'/confirm/'+p.preview_token,{method:'POST'}).catch(Object);}));
    else if(a==='discard-all')await Promise.all(previews.map(function(p){return fetch(MCP+'/preview/'+p.preview_token,{method:'DELETE'}).catch(Object);}));
    else if(a==='confirm-one')await fetch(MCP+'/confirm/'+t,{method:'POST'}).catch(Object);
    else if(a==='discard-one')await fetch(MCP+'/preview/'+t,{method:'DELETE'}).catch(Object);
    if(a==='confirm-all'||a==='discard-all')open=false;
    load();
  }

  function render(){
    var root=document.getElementById('pb-root');if(!root)return;
    if(!previews.length){root.innerHTML='';document.body.style.paddingBottom='';hideFloat();return;}
    root.innerHTML=buildHTML();
    document.body.style.paddingBottom='52px';
    if(!bound){root.addEventListener('click',onBannerClick);bound=true;}
  }

  function focusFromURL(){
    if(pbFocusDone)return;
    var token=(new URLSearchParams(location.search)).get('pb_focus');
    if(!token)return;
    pbFocusDone=true;
    var els=markedTokens();
    var idx=els.findIndex(function(e){return e.dataset.pbToken===token;});
    if(idx===-1)return;
    hlIndex=idx;
    els[idx].scrollIntoView({behavior:'smooth',block:'center'});
    showFloat(els[idx],token,els[idx].dataset.pbAction||'update');
    render();
  }

  async function load(){
    try{var r=await fetch(MCP+'/previews');previews=r.ok?await r.json():[];}catch(e){previews=[];}
    render();applyHighlights();focusFromURL();
  }

  getDom();
  load();

  document.addEventListener('astro:page-load',function(){
    bound=false;
    pbFocusDone=false;
    getDom();
    load();
  });
})();</script>`;
}

function injectBanner(html: string, mcpUrlWithSession: string): string {
  const injection = buildBannerInjection(mcpUrlWithSession);
  const idx = html.lastIndexOf("</body>");
  if (idx === -1) return html + injection;
  return html.slice(0, idx) + injection + html.slice(idx);
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  { name: "list_collections", description: "List all user-facing collections in the Directus instance. Shows collection name, singleton status, icon, and note. Call this first to understand the available data model.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "get_collection_fields", description: "Get all fields for a specific collection, including field type, whether it is required, and UI options. Use this to understand what data a collection holds before reading or writing.", inputSchema: { type: "object", properties: { collection: { type: "string", description: "Collection name (e.g. 'menu_items')" } }, required: ["collection"] } },
  { name: "get_schema", description: "Get the full schema: all collections, all fields, and all relations in one call. Useful for a complete picture of the data model.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "read_items", description: "Read multiple items from a collection. Supports field selection, Directus filter objects, sorting, pagination, and full-text search.", inputSchema: { type: "object", properties: { collection: { type: "string", description: "Collection name" }, fields: { type: "array", items: { type: "string" }, description: "Fields to include in the response. Omit for all fields." }, filter: { type: "object", description: "Directus filter object, e.g. { \"available\": { \"_eq\": true } }" }, sort: { type: "array", items: { type: "string" }, description: "Sort fields. Prefix with '-' for descending, e.g. [\"-price\"]" }, limit: { type: "number", description: "Maximum number of items to return" }, offset: { type: "number", description: "Number of items to skip (for pagination)" }, search: { type: "string", description: "Full-text search string" } }, required: ["collection"] } },
  { name: "read_item", description: "Read a single item by primary key. If you only know a human-readable field (e.g. dish name), use read_items with a filter instead.", inputSchema: { type: "object", properties: { collection: { type: "string", description: "Collection name" }, id: { description: ITEM_PK_DESCRIPTION }, fields: { type: "array", items: { type: "string" }, description: "Fields to include in the response" } }, required: ["collection", "id"] } },
  { name: "read_singleton", description: "Read the data of a singleton collection (a collection with exactly one record, e.g. 'site_settings', 'hero', 'about'). Use list_collections to identify which collections are singletons.", inputSchema: { type: "object", properties: { collection: { type: "string", description: "Singleton collection name" }, fields: { type: "array", items: { type: "string" }, description: "Fields to include in the response" } }, required: ["collection"] } },
  { name: "confirm_preview", description: "Apply a staged change to Directus. Call this only after the user has explicitly confirmed they want to apply the change. Pass the preview_token from the staging tool response. Returns a success message when the change has been written.", inputSchema: { type: "object", properties: { token: { type: "string", description: "The preview_token returned by create_item, update_item, update_items, update_singleton, or delete_item." } }, required: ["token"] } },
  { name: "discard_preview", description: "Discard a staged change without writing anything. Call this when the user wants to cancel the pending change. Pass the preview_token from the staging tool response.", inputSchema: { type: "object", properties: { token: { type: "string", description: "The preview_token returned by the staging tool." } }, required: ["token"] } },
  { name: "list_previews", description: "List all currently staged (unconfirmed) changes for this session. Use this to show the user what is pending before a bulk confirm or discard.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "confirm_all_previews", description: "Confirm and apply every staged change at once. Call this only after the user has explicitly approved applying all pending changes.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "discard_all_previews", description: "Discard every staged change without writing anything. Nothing is written to Directus.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "create_item", description: "Stage a new item for creation. If you need to create multiple items, call this tool for each one before presenting anything to the user. Nothing is written until confirmed.", inputSchema: { type: "object", properties: { collection: { type: "string", description: "Collection name" }, data: { type: "object", description: "Item data as key-value pairs matching the collection's fields" } }, required: ["collection", "data"] } },
  { name: "update_item", description: "Stage an update to an existing item. If you need to update multiple items, call this tool for each one before presenting anything to the user. Nothing is written until confirmed.", inputSchema: { type: "object", properties: { collection: { type: "string", description: "Collection name" }, id: { description: ITEM_PK_DESCRIPTION }, data: { type: "object", description: "Fields to update as key-value pairs (partial update)" } }, required: ["collection", "id", "data"] } },
  { name: "update_items", description: "Stage the same update for multiple items in a collection at once. Internally creates one preview per item (each with its own before/after diff) — equivalent to calling update_item N times but in a single tool call. Returns one preview_token per item. Nothing is written until confirmed.", inputSchema: { type: "object", properties: { collection: { type: "string", description: "Collection name" }, ids: { type: "array", items: { type: "string" }, description: `List of primary keys to update. ${ITEM_PK_DESCRIPTION}` }, data: { type: "object", description: "Fields to set on all matched items (partial update)" } }, required: ["collection", "ids", "data"] } },
  { name: "update_singleton", description: "Stage an update to a singleton collection (e.g. 'site_settings', 'hero', 'about'). Returns a before/after diff, a preview_token for in-chat confirmation, and a preview_url for visual inspection. Nothing is written until confirm_preview is called.", inputSchema: { type: "object", properties: { collection: { type: "string", description: "Singleton collection name" }, data: { type: "object", description: "Fields to update as key-value pairs" } }, required: ["collection", "data"] } },
  { name: "delete_item", description: "Stage a deletion. If you need to delete multiple items, call this tool for each one before presenting anything to the user. Nothing is deleted until confirmed.", inputSchema: { type: "object", properties: { collection: { type: "string", description: "Collection name" }, id: { description: ITEM_PK_DESCRIPTION } }, required: ["collection", "id"] } },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(data: unknown)    { return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] }; }
function text(s: string)      { return { content: [{ type: "text" as const, text: s }] }; }
function err(message: string) { return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true }; }

function parseData(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  }
  return (raw ?? {}) as Record<string, unknown>;
}

async function validateFields(
  client: DirectusClient,
  collection: string,
  data: Record<string, unknown>,
): Promise<string | null> {
  const fieldsRes = await client.getCollectionFields(collection) as Array<{ field: string }>;
  const validFields = new Set(fieldsRes.map((f) => f.field));
  const unknown = Object.keys(data).filter((k) => !validFields.has(k));
  if (unknown.length === 0) return null;
  const valid = fieldsRes.map((f) => f.field).join(", ");
  return `Unknown field(s) for '${collection}': ${unknown.join(", ")}.\nValid fields: ${valid}.\nOnly use fields from that list.`;
}

async function applyEntry(client: DirectusClient, entry: PreviewEntry): Promise<void> {
  switch (entry.action) {
    case "create":           await client.createItem(entry.collection, entry.data!); break;
    case "update":           await client.updateItem(entry.collection, entry.id!, entry.data!); break;
    case "update_singleton": await client.updateSingleton(entry.collection, entry.data!); break;
    case "delete":           await client.deleteItem(entry.collection, entry.id!); break;
  }
}

// ── MCP Server factory ────────────────────────────────────────────────────────

function makeServer(sessionId: string, info: SessionInfo): Server {
  const server = new Server({ name: "directus-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
  const client = makeClient(info);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    process.stderr.write(`[mcp] session=${sessionId} tool=${name}\n`);

    try {
      switch (name) {
        case "list_collections":
          return ok(await client.listCollections());

        case "get_collection_fields": {
          const { collection } = args as { collection: string };
          return ok(await client.getCollectionFields(collection));
        }

        case "get_schema":
          return ok(await client.getSchema());

        case "read_items": {
          const { collection, fields, filter, sort, limit, offset, search } = args as {
            collection: string; fields?: string[]; filter?: Record<string, unknown>;
            sort?: string[]; limit?: number; offset?: number; search?: string;
          };
          return ok(await client.readItems(collection, { fields, filter, sort, limit, offset, search }));
        }

        case "read_item": {
          const { collection, id, fields } = args as { collection: string; id: string | number; fields?: string[] };
          return ok(await client.readItem(collection, id, fields));
        }

        case "read_singleton": {
          const { collection, fields } = args as { collection: string; fields?: string[] };
          return ok(await client.readSingleton(collection, fields));
        }

        case "create_item": {
          const { collection } = args as { collection: string };
          const data = parseData((args as { data?: unknown }).data);
          const fieldErr = await validateFields(client, collection, data);
          if (fieldErr) return err(fieldErr);
          const entry: PreviewEntry = { session_id: sessionId, action: "create", collection, after: data, data };
          const token = storePreview(entry);
          return text(buildPreviewResponse(token, entry));
        }

        case "update_item": {
          const { collection, id } = args as { collection: string; id: string | number };
          const data = parseData((args as { data?: unknown }).data);
          const fieldErr = await validateFields(client, collection, data);
          if (fieldErr) return err(fieldErr);
          const res = await client.readItem(collection, id) as { data: Record<string, unknown> };
          const before = res.data;
          const after = { ...before, ...data };
          const entry: PreviewEntry = {
            session_id: sessionId, action: "update", collection, id,
            before, after, diff: computeDiff(before, data), data,
          };
          const token = storePreview(entry);
          return text(buildPreviewResponse(token, entry));
        }

        case "update_items": {
          const { collection } = args as { collection: string };
          const data = parseData((args as { data?: unknown }).data);
          const fieldErr = await validateFields(client, collection, data);
          if (fieldErr) return err(fieldErr);
          const rawIds = (args as { ids: unknown }).ids;
          const ids: (string | number)[] = Array.isArray(rawIds)
            ? rawIds as (string | number)[]
            : typeof rawIds === "string"
              ? rawIds.split(",").map((s) => s.trim()).filter(Boolean)
              : typeof rawIds === "number"
                ? [rawIds]
                : [];
          if (!ids.length) return err("No ids provided to update_items.");

          // Behave like calling update_item in a loop — one preview entry per item,
          // each with its own before/after diff so HTML rewriting works cleanly.
          const staged: { token: string; entry: PreviewEntry }[] = [];
          for (const id of ids) {
            const res = await client.readItem(collection, id) as { data: Record<string, unknown> };
            const before = res.data;
            const after = { ...before, ...data };
            const entry: PreviewEntry = {
              session_id: sessionId, action: "update", collection, id,
              before, after, diff: computeDiff(before, data), data,
            };
            staged.push({ token: storePreview(entry), entry });
          }
          return text(buildBulkPreviewResponse(staged));
        }

        case "update_singleton": {
          const { collection } = args as { collection: string };
          const data = parseData((args as { data?: unknown }).data);
          const fieldErr = await validateFields(client, collection, data);
          if (fieldErr) return err(fieldErr);
          const res = await client.readSingleton(collection) as { data: Record<string, unknown> };
          const before = res.data;
          const after = { ...before, ...data };
          const entry: PreviewEntry = {
            session_id: sessionId, action: "update_singleton", collection,
            before, after, diff: computeDiff(before, data), data,
          };
          const token = storePreview(entry);
          return text(buildPreviewResponse(token, entry));
        }

        case "delete_item": {
          const { collection, id } = args as { collection: string; id: string | number };
          const res = await client.readItem(collection, id) as { data: Record<string, unknown> };
          const entry: PreviewEntry = {
            session_id: sessionId, action: "delete", collection, id, before: res.data,
          };
          const token = storePreview(entry);
          return text(buildPreviewResponse(token, entry));
        }

        case "confirm_preview": {
          const { token } = args as { token: string };
          const stored = previewStore.get(token);
          if (!stored || stored.entry.session_id !== sessionId) {
            return err("Preview not found — it may have already been confirmed, discarded, or expired.");
          }
          const { entry } = stored;
          clearTimeout(stored.timer);
          previewStore.delete(token);
          await applyEntry(client, entry);
          return text(`✓ Done. ${entry.action} on ${entry.collection}${entry.id != null ? ` #${entry.id}` : ""} has been written to Directus.`);
        }

        case "discard_preview": {
          const { token } = args as { token: string };
          const stored = previewStore.get(token);
          if (!stored || stored.entry.session_id !== sessionId) {
            return err("Preview not found — it may have already been confirmed, discarded, or expired.");
          }
          clearTimeout(stored.timer);
          previewStore.delete(token);
          return text(`✗ Discarded. Nothing was written to Directus.`);
        }

        case "list_previews": {
          const ours = previewsForSession(sessionId);
          if (ours.length === 0) return text("No staged changes.");
          const lines = ours.map(({ token, entry }) => {
            const diff = entry.diff?.map((d) => `${d.field}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`).join(", ") ?? "";
            return `- [${entry.action}] ${entry.collection}${entry.id != null ? ` #${entry.id}` : ""}${diff ? `  (${diff})` : ""}  token: ${token}`;
          });
          return text(`Staged changes (${ours.length}):\n${lines.join("\n")}`);
        }

        case "confirm_all_previews": {
          const ours = previewsForSession(sessionId);
          if (!ours.length) return text("No staged changes to confirm.");
          for (const { token, entry } of ours) {
            const stored = previewStore.get(token);
            if (stored) { clearTimeout(stored.timer); previewStore.delete(token); }
            await applyEntry(client, entry);
          }
          return text(`✓ All ${ours.length} change(s) confirmed and written to Directus.`);
        }

        case "discard_all_previews": {
          const ours = previewsForSession(sessionId);
          if (!ours.length) return text("No staged changes to discard.");
          for (const { token } of ours) {
            const stored = previewStore.get(token);
            if (stored) { clearTimeout(stored.timer); previewStore.delete(token); }
          }
          return text(`✗ All ${ours.length} staged change(s) discarded. Nothing was written to Directus.`);
        }

        default:
          return err(`Unknown tool: ${name}`);
      }
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  });

  return server;
}

// ── Main HTTP server ──────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, x-session-id, x-directus-url, x-directus-token, x-directus-email, x-directus-password, x-website-url, x-website-public-url",
};

async function readBody(req: http.IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", resolve);
    req.on("error", reject);
  });
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

const httpServer = http.createServer();

httpServer.on("request", (req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "OPTIONS") { res.writeHead(204, CORS_HEADERS).end(); return; }

    // ── MCP tool endpoint ──────────────────────────────────────────────────
    if (path === "/mcp") {
      const buf = await readBody(req);
      const body = buf ? (JSON.parse(buf.toString()) as unknown) : undefined;
      const { id: sessionId, info } = getOrCreateSession(req);

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = makeServer(sessionId, info);
      res.on("close", () => transport.close().catch(() => {}));
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    // ── /sessions/:sid/previews ────────────────────────────────────────────
    const sessionPreviewsMatch = /^\/sessions\/([^/]+)\/previews$/.exec(path);
    if (method === "GET" && sessionPreviewsMatch) {
      const sid = decodeURIComponent(sessionPreviewsMatch[1]!);
      const entries = previewsForSession(sid).map(({ token, entry }) => ({
        ...entry,
        preview_token: token,
        preview_pages: previewPagesForCollection(entry.collection),
      }));
      res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
        .end(JSON.stringify(entries));
      return;
    }

    // ── /sessions/:sid/preview/:token (GET / DELETE) ───────────────────────
    const sessionPreviewTokenMatch = /^\/sessions\/([^/]+)\/preview\/([^/]+)$/.exec(path);
    if (sessionPreviewTokenMatch) {
      const sid = decodeURIComponent(sessionPreviewTokenMatch[1]!);
      const token = decodeURIComponent(sessionPreviewTokenMatch[2]!);
      const stored = previewStore.get(token);
      const valid = stored && stored.entry.session_id === sid;
      if (method === "GET") {
        if (!valid) { res.writeHead(404, { "Content-Type": "application/json", ...CORS_HEADERS }).end(JSON.stringify({ error: "Preview not found or expired" })); return; }
        res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
          .end(JSON.stringify({ ...stored!.entry, preview_token: token }));
        return;
      }
      if (method === "DELETE") {
        if (valid) { clearTimeout(stored!.timer); previewStore.delete(token); }
        res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS }).end(JSON.stringify({ success: true }));
        return;
      }
    }

    // ── POST /sessions/:sid/confirm/:token ─────────────────────────────────
    const sessionConfirmMatch = /^\/sessions\/([^/]+)\/confirm\/([^/]+)$/.exec(path);
    if (method === "POST" && sessionConfirmMatch) {
      const sid = decodeURIComponent(sessionConfirmMatch[1]!);
      const token = decodeURIComponent(sessionConfirmMatch[2]!);
      const stored = previewStore.get(token);
      if (!stored || stored.entry.session_id !== sid) {
        res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
          .end(JSON.stringify({ success: true, alreadyApplied: true }));
        return;
      }
      const { entry } = stored;
      clearTimeout(stored.timer);
      previewStore.delete(token);
      const info: SessionInfo = sessionMap.get(sid) ?? { directusUrl: "", lastUsed: Date.now() };
      const client = makeClient(info);
      await applyEntry(client, entry);
      res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
        .end(JSON.stringify({ success: true, action: entry.action, collection: entry.collection }));
      return;
    }

    // ── GET /sessions/:sid/review/:token ───────────────────────────────────
    const sessionReviewMatch = /^\/sessions\/([^/]+)\/review\/([^/]+)$/.exec(path);
    if (method === "GET" && sessionReviewMatch) {
      const sid = decodeURIComponent(sessionReviewMatch[1]!);
      const token = decodeURIComponent(sessionReviewMatch[2]!);
      const previews = previewsForSession(sid).map(({ token: t, entry }) => ({ ...entry, preview_token: t }));
      const html = buildReviewPage(sid, token, previews);
      const stored = previewStore.get(token);
      const status = stored && stored.entry.session_id === sid ? 200 : 404;
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(html);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "Not found" }));
  })().catch((e: unknown) => {
    process.stderr.write(`[http] error: ${e instanceof Error ? e.message : String(e)}\n`);
    if (!res.headersSent) res.writeHead(500).end();
  });
});

httpServer.listen(PORT, () => {
  process.stderr.write(`directus-mcp listening on http://0.0.0.0:${PORT}/mcp\n`);
});

// ── Preview proxy (subdomain-routed) ──────────────────────────────────────────
//
// Browser hits e.g. http://abc123.localhost:4322/menu. The proxy reads the
// subdomain to find the session, fetches the customer's website at the
// session's configured websiteUrl, applies staged changes to the HTML, and
// injects the banner.

function extractSessionFromHost(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const host = hostHeader.split(":")[0]!;
  const parts = host.split(".");
  if (parts.length < 2) return null;
  return parts[0] || null;
}

const previewProxyServer = http.createServer();

previewProxyServer.on("request", (req, res) => {
  void (async () => {
    const method = req.method ?? "GET";
    if (method === "OPTIONS") { res.writeHead(204, CORS_HEADERS).end(); return; }

    const hostHeader = req.headers.host;
    const sid = extractSessionFromHost(hostHeader);
    if (!sid) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<h1>404 — Missing session subdomain</h1>`);
      return;
    }
    const info = sessionMap.get(sid);
    if (!info || !info.websiteUrl) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<h1>404 — Unknown preview session</h1><p>No website URL configured for session <code>${escHtml(sid)}</code>.</p>`);
      return;
    }
    info.lastUsed = Date.now();

    const url = new URL(req.url ?? "/", `http://localhost:${PREVIEW_PROXY_PORT}`);
    const targetBase = info.websiteUrl.replace(/\/$/, "");
    const targetUrl = `${targetBase}${url.pathname}${url.search || ""}`;
    process.stderr.write(`[preview-proxy] session=${sid} ${method} ${url.pathname} → ${targetUrl}\n`);

    const reqBody = await readBody(req);

    const forwardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (["host", "connection", "transfer-encoding", "content-length"].includes(key.toLowerCase())) continue;
      forwardHeaders[key] = Array.isArray(value) ? value[0]! : (value ?? "");
    }

    let upstream: Response;
    try {
      upstream = await fetch(targetUrl, {
        method,
        headers: forwardHeaders,
        body: reqBody?.length ? new Uint8Array(reqBody) : undefined,
        redirect: "manual",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[preview-proxy] fetch failed: ${msg}\n`);
      res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<h1>502 — Cannot reach upstream</h1><p>Target: <code>${escHtml(targetUrl)}</code></p><pre>${escHtml(msg)}</pre>`);
      return;
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    const mcpForSession = `${MCP_PUBLIC_URL}/sessions/${encodeURIComponent(sid)}`;

    if (method === "GET" && contentType.includes("text/html") && upstream.ok) {
      let html = await upstream.text();
      html = applyPreviewsToHtml(html, sid);
      html = injectBanner(html, mcpForSession);
      const outHeaders: Record<string, string> = { "Content-Type": "text/html; charset=utf-8" };
      const cc = upstream.headers.get("cache-control");
      if (cc) outHeaders["Cache-Control"] = "no-store"; // never cache rewritten HTML
      res.writeHead(upstream.status, outHeaders).end(html);
      return;
    }

    // Pass through everything else verbatim (assets, JSON, redirects, etc.)
    const resBody = Buffer.from(await upstream.arrayBuffer());
    const outHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (["content-encoding", "transfer-encoding", "content-length"].includes(key.toLowerCase())) return;
      outHeaders[key] = value;
    });
    res.writeHead(upstream.status, outHeaders).end(resBody);
  })().catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[preview-proxy] error: ${msg}\n`);
    if (!res.headersSent) res.writeHead(502).end(`Preview proxy error: ${msg}`);
  });
});

previewProxyServer.listen(PREVIEW_PROXY_PORT, () => {
  process.stderr.write(`preview-proxy listening on http://0.0.0.0:${PREVIEW_PROXY_PORT}/\n`);
});
