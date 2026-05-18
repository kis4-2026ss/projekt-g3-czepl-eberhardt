import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { DirectusClient, computeDiff, type DiffEntry, type DirectusClientOpts } from "./directus.js";
import * as db from "./db.js";
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
//
// Sessions and previews live in Postgres (see ./db.ts) — no in-memory store,
// no TTL. A session row is the "address book" for a chat: which Directus and
// which website does this chat operate against. Previews stay until the user
// explicitly confirms or discards them.

interface SessionInfo {
  directusUrl: string;
  directusToken?: string;
  directusEmail?: string;
  directusPassword?: string;
  websiteUrl?: string;        // what the preview proxy fetches from
  websitePublicUrl?: string;  // optional display URL (not used internally)
}

function rowToInfo(row: db.SessionRow): SessionInfo {
  return {
    directusUrl:       row.directus_url,
    directusToken:     row.directus_token ?? undefined,
    directusEmail:     row.directus_email ?? undefined,
    directusPassword:  row.directus_password ?? undefined,
    websiteUrl:        row.website_url ?? undefined,
    websitePublicUrl:  row.website_public_url ?? undefined,
  };
}

// ── Request helpers ───────────────────────────────────────────────────────────

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

async function getOrCreateSession(req: http.IncomingMessage): Promise<{ id: string; info: SessionInfo }> {
  const id = header(req, "x-session-id") || "default";
  const existing = await db.getSession(id);
  const isNew = !existing;

  const row = await db.upsertSession(id, {
    directusUrl:       header(req, "x-directus-url"),
    directusToken:     header(req, "x-directus-token"),
    directusEmail:     header(req, "x-directus-email"),
    directusPassword:  header(req, "x-directus-password"),
    websiteUrl:        header(req, "x-website-url"),
    websitePublicUrl:  header(req, "x-website-public-url"),
  });

  if (isNew) {
    process.stderr.write(`[session] new ${id} directus=${row.directus_url} website=${row.website_url ?? ""}\n`);
  }
  return { id, info: rowToInfo(row) };
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

function rowToEntry(row: db.PreviewRow): PreviewEntry {
  return {
    session_id: row.session_id,
    action: row.action,
    collection: row.collection,
    id: row.item_id ?? undefined,
    before: row.before_json ?? undefined,
    after: row.after_json ?? undefined,
    diff: (row.diff_json as DiffEntry[] | null) ?? undefined,
    data: row.data_json ?? undefined,
  };
}

async function storePreview(entry: PreviewEntry): Promise<string> {
  const token = randomUUID();
  await db.insertPreview({
    token,
    sessionId: entry.session_id,
    action: entry.action,
    collection: entry.collection,
    itemId: entry.id,
    before: entry.before,
    after: entry.after,
    diff: entry.diff,
    data: entry.data,
  });
  return token;
}

async function previewsForSession(sessionId: string): Promise<{ token: string; entry: PreviewEntry }[]> {
  const rows = await db.getPreviewsForSession(sessionId);
  return rows.map((r) => ({ token: r.token, entry: rowToEntry(r) }));
}

function buildPreviewResponse(token: string, entry: PreviewEntry): string {
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
    `The user sees this change as an interactive card in the chat with Übernehmen/Verwerfen buttons — do NOT share any URLs.`,
    `If you still have more changes to stage, call the next write tool now without pausing.`,
    `When all changes are staged, briefly tell the user what you prepared (one short sentence) and let them confirm via the inline card.`,
  ].join("\n");
}

function buildBulkPreviewResponse(staged: { token: string; entry: PreviewEntry }[]): string {
  if (!staged.length) return "Nothing to stage.";

  const lines = staged.map(({ token, entry }) => {
    const diff = entry.diff?.map((d) => `${d.field}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`).join(", ") ?? "";
    return `  - ${entry.collection}#${entry.id}${diff ? `  (${diff})` : ""}  token: ${token}`;
  }).join("\n");

  return [
    `Staged ${staged.length} change${staged.length === 1 ? "" : "s"} (one preview per item):`,
    lines,
    ``,
    `The user sees these changes as an interactive group card in the chat with per-item Übernehmen/Verwerfen buttons — do NOT share any URLs.`,
    `If you still have more changes to stage, call the next write tool now without pausing.`,
    `When all changes are staged, briefly tell the user what you prepared (one short sentence) and let them confirm via the inline cards.`,
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

async function applyPreviewsToHtml(html: string, sessionId: string): Promise<string> {
  const entries = (await previewsForSession(sessionId)).map((p) => p.entry);
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
    create: "Neu", update: "Änderung",
    update_singleton: "Aktualisierung", delete: "Löschung",
  };
  const actionClass: Record<string, string> = {
    create: "lbl-create", update: "lbl-update",
    update_singleton: "lbl-singleton", delete: "lbl-delete",
  };
  const diffRows = p.diff && p.diff.length > 0
    ? `<div class="diff">
        <div class="diff-head">
          <span class="dh-cell dh-field">Feld</span>
          <span class="dh-cell dh-before">Vorher</span>
          <span class="dh-arrow"></span>
          <span class="dh-cell dh-after">Nachher</span>
        </div>
        ${p.diff.map((d) => `
          <div class="diff-row">
            <span class="d-field">${escHtml(d.field)}</span>
            <span class="d-before">${escHtml(JSON.stringify(d.before) ?? "—")}</span>
            <span class="d-arrow">→</span>
            <span class="d-after">${escHtml(JSON.stringify(d.after) ?? "—")}</span>
          </div>`).join("")}
      </div>`
    : p.after
      ? `<details class="raw-block" open><summary>Vollständige Daten</summary><pre><code>${escHtml(JSON.stringify(p.after, null, 2))}</code></pre></details>`
      : "";

  const jumpUrl = `${previewBaseUrl}${previewPagesForCollection(p.collection)[0]}?pb_focus=${encodeURIComponent(p.preview_token)}`;
  const tokenShort = p.preview_token.slice(0, 8);

  return `
  <article class="card${highlighted ? " card-highlight" : ""}" id="card-${escHtml(p.preview_token)}">
    <header class="card-head">
      <div class="card-meta">
        <span class="label ${escHtml(actionClass[p.action] ?? "lbl-update")}"><span class="lbl-dot"></span>${escHtml(actionLabel[p.action] ?? p.action)}</span>
        <span class="card-title">${escHtml(p.collection)}${p.id != null ? `<span class="card-id">#${escHtml(String(p.id))}</span>` : ""}</span>
        <span class="card-token" title="Preview-Token">${escHtml(tokenShort)}</span>
      </div>
      <div class="card-actions">
        <a href="${escHtml(jumpUrl)}" class="btn btn-ghost btn-sm" target="_blank" rel="noopener" title="In der Live-Vorschau anzeigen">
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9.5l4.5-4.5M5.5 5H10v4.5"/></svg>
          <span>Vorschau</span>
        </a>
        <button class="btn btn-confirm btn-sm" data-confirm="${escHtml(p.preview_token)}">
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l3 3 5-6"/></svg>
          <span>Übernehmen</span>
        </button>
        <button class="btn btn-discard btn-sm" data-discard="${escHtml(p.preview_token)}">
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg>
          <span>Verwerfen</span>
        </button>
      </div>
    </header>
    ${diffRows}
    <div class="status" id="s-${escHtml(p.preview_token)}"></div>
  </article>`;
}

function buildReviewPage(sessionId: string, focusToken: string, allPreviews: StoredPreview[]): string {
  const previewBaseUrl = `http://${sessionId}.${PREVIEW_HOST}`;
  const found   = allPreviews.length > 0;
  const hasMany = allPreviews.length > 1;
  const apiBase = `/sessions/${encodeURIComponent(sessionId)}`;

  // Action breakdown for header summary
  const counts: Record<string, number> = {};
  allPreviews.forEach((p) => { counts[p.action] = (counts[p.action] ?? 0) + 1; });
  const summaryBits: string[] = [];
  if (counts.create) summaryBits.push(`<span class="sum sum-create">${counts.create} neu</span>`);
  if (counts.update) summaryBits.push(`<span class="sum sum-update">${counts.update} geändert</span>`);
  if (counts.update_singleton) summaryBits.push(`<span class="sum sum-singleton">${counts.update_singleton} aktualisiert</span>`);
  if (counts.delete) summaryBits.push(`<span class="sum sum-delete">${counts.delete} gelöscht</span>`);

  const cards = found
    ? allPreviews.map((p) => renderEntryCard(p, p.preview_token === focusToken, previewBaseUrl)).join("")
    : `<div class="empty-state">
        <div class="empty-glyph">
          <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="16" cy="16" r="13"/><path d="M16 9v8M16 21v.5"/></svg>
        </div>
        <div class="empty-title">Nichts zu prüfen</div>
        <p class="empty-msg">Diese Vorschau wurde nicht gefunden oder ist abgelaufen.</p>
      </div>`;

  const bulkBar = hasMany ? `
  <div class="bulk-bar">
    <div class="bb-info">
      <span class="bb-count">${allPreviews.length}</span>
      <span class="bb-label">Änderungen ausstehend</span>
    </div>
    <div class="bb-actions">
      <button class="btn btn-confirm" id="confirm-all">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l3 3 5-6"/></svg>
        Alle übernehmen
      </button>
      <button class="btn btn-discard" id="discard-all">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg>
        Alle verwerfen
      </button>
    </div>
    <div class="status" id="s-all"></div>
  </div>` : "";

  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#faf8f3">
  <title>Vorschau · ${allPreviews.length} Änderungen</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..900;1,9..144,300..900&family=Geist:wght@300..700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --paper:#faf8f3;--paper-2:#f3efe5;--paper-3:#ece6d6;--paper-card:#ffffff;
      --ink:#1a1816;--ink-2:#3d3a35;--ink-3:#6b6660;--ink-4:#9c958a;--ink-5:#c3bcae;
      --line:#e7e1d0;--line-2:#d6cfbd;
      --accent:#b8401b;--accent-2:#d35a35;--accent-soft:#fae9e0;
      --create:#4f7a3a;--create-soft:#e6efd9;
      --update:#b8401b;--update-soft:#fae9e0;
      --singleton:#2e5d8a;--singleton-soft:#dde9f3;
      --delete:#b32d23;--delete-soft:#fadbd7;
      --shadow-1:0 1px 2px rgba(26,24,22,.04),0 1px 1px rgba(26,24,22,.03);
      --shadow-2:0 2px 6px rgba(26,24,22,.05),0 1px 2px rgba(26,24,22,.04);
      --shadow-3:0 12px 32px -8px rgba(26,24,22,.18),0 4px 12px -4px rgba(26,24,22,.08);
      --grain:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.04 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>");
      --font-display:'Fraunces','Times New Roman',Georgia,serif;
      --font-body:'Geist',system-ui,-apple-system,sans-serif;
      --font-mono:'JetBrains Mono','Menlo','Consolas',monospace;
    }
    html,body{min-height:100vh}
    body{
      font-family:var(--font-body);font-size:14px;line-height:1.55;
      color:var(--ink);background:var(--paper);
      -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;
      letter-spacing:-.002em;padding-bottom:4rem;
    }
    body::before{content:'';position:fixed;inset:0;background-image:var(--grain);pointer-events:none;opacity:.5;z-index:0;mix-blend-mode:multiply}
    ::selection{background:var(--accent);color:#fff}
    :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}

    .page{position:relative;z-index:1;max-width:960px;margin:0 auto;padding:2.25rem 1.5rem 2rem}

    /* ── Header ── */
    .head{
      display:flex;align-items:flex-start;gap:1.25rem;flex-wrap:wrap;
      margin-bottom:1.75rem;padding-bottom:1.25rem;
      border-bottom:1px solid var(--line);
    }
    .brand{display:flex;align-items:center;gap:.7rem;flex-shrink:0}
    .brand-mark{
      width:34px;height:34px;border-radius:50%;
      background:var(--ink);color:var(--paper);
      display:grid;place-items:center;
      font-family:var(--font-display);font-style:italic;font-weight:500;
      font-size:21px;line-height:1;letter-spacing:-.02em;
    }
    .brand-text{display:flex;flex-direction:column;gap:1px}
    .brand-eyebrow{
      font-size:10.5px;font-weight:600;letter-spacing:.16em;
      text-transform:uppercase;color:var(--ink-4);
    }
    .brand-title{
      font-family:var(--font-display);font-style:italic;font-weight:400;
      font-size:24px;line-height:1.05;letter-spacing:-.02em;color:var(--ink);
    }
    .brand-title em{color:var(--accent);font-style:italic}
    .head-spacer{flex:1}
    .summary{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;margin-top:.45rem}
    .sum{
      display:inline-flex;align-items:center;gap:.35rem;
      padding:.18rem .55rem;border-radius:99px;
      font-family:var(--font-mono);font-size:11px;font-weight:500;letter-spacing:0;
      border:1px solid;font-variant-numeric:tabular-nums;
    }
    .sum::before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor}
    .sum-create{color:var(--create);background:var(--create-soft);border-color:color-mix(in srgb,var(--create) 25%,transparent)}
    .sum-update{color:var(--update);background:var(--update-soft);border-color:color-mix(in srgb,var(--update) 25%,transparent)}
    .sum-singleton{color:var(--singleton);background:var(--singleton-soft);border-color:color-mix(in srgb,var(--singleton) 25%,transparent)}
    .sum-delete{color:var(--delete);background:var(--delete-soft);border-color:color-mix(in srgb,var(--delete) 25%,transparent)}

    .live-link{
      display:inline-flex;align-items:center;gap:.45rem;
      padding:.5rem .85rem;border-radius:8px;
      background:var(--ink);color:var(--paper);
      font-size:12.5px;font-weight:500;text-decoration:none;
      transition:transform 120ms,background 120ms,box-shadow 120ms;
      box-shadow:var(--shadow-1);align-self:flex-start;
    }
    .live-link:hover{background:var(--ink-2);transform:translateY(-1px);box-shadow:var(--shadow-2)}
    .live-link svg{width:13px;height:13px}

    /* ── Bulk bar (sticky) ── */
    .bulk-bar{
      position:sticky;top:0;z-index:10;
      background:var(--paper-card);border:1px solid var(--line);
      border-radius:12px;padding:.85rem 1.1rem;margin-bottom:1.25rem;
      display:flex;align-items:center;gap:1rem;flex-wrap:wrap;
      box-shadow:var(--shadow-2);
    }
    .bb-info{display:flex;align-items:baseline;gap:.5rem}
    .bb-count{
      font-family:var(--font-display);font-weight:500;font-size:22px;
      color:var(--ink);line-height:1;font-variant-numeric:tabular-nums;
    }
    .bb-label{font-size:13px;color:var(--ink-3)}
    .bb-actions{margin-left:auto;display:flex;gap:.4rem}
    #s-all{flex-basis:100%}

    /* ── Card ── */
    .card{
      background:var(--paper-card);border:1px solid var(--line);
      border-radius:12px;padding:1.1rem 1.25rem;margin-bottom:.85rem;
      box-shadow:var(--shadow-1);
      transition:border-color 180ms,box-shadow 180ms,transform 180ms;
      scroll-margin-top:1rem;
    }
    .card:hover{box-shadow:var(--shadow-2)}
    .card-highlight{
      border-color:var(--accent);
      box-shadow:0 0 0 3px var(--accent-soft),var(--shadow-2);
      animation:focus-in 600ms cubic-bezier(.2,.6,.3,1);
    }
    @keyframes focus-in{
      0%{transform:scale(.992)}
      60%{transform:scale(1.004)}
      100%{transform:scale(1)}
    }

    .card-head{display:flex;align-items:center;gap:.85rem;flex-wrap:wrap}
    .card-meta{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;min-width:0;flex:1}
    .label{
      display:inline-flex;align-items:center;gap:.35rem;
      padding:.22rem .55rem .22rem .45rem;border-radius:99px;
      font-family:var(--font-mono);font-size:10.5px;font-weight:500;
      text-transform:uppercase;letter-spacing:.06em;
      border:1px solid;white-space:nowrap;
    }
    .lbl-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0}
    .lbl-create{color:var(--create);background:var(--create-soft);border-color:color-mix(in srgb,var(--create) 25%,transparent)}
    .lbl-update{color:var(--update);background:var(--update-soft);border-color:color-mix(in srgb,var(--update) 25%,transparent)}
    .lbl-singleton{color:var(--singleton);background:var(--singleton-soft);border-color:color-mix(in srgb,var(--singleton) 25%,transparent)}
    .lbl-delete{color:var(--delete);background:var(--delete-soft);border-color:color-mix(in srgb,var(--delete) 25%,transparent)}
    .card-title{
      font-size:14.5px;font-weight:600;color:var(--ink);letter-spacing:-.005em;
      display:inline-flex;align-items:baseline;gap:.4rem;
    }
    .card-id{font-family:var(--font-mono);font-weight:500;font-size:12.5px;color:var(--ink-3);letter-spacing:0}
    .card-token{
      font-family:var(--font-mono);font-size:10.5px;
      color:var(--ink-4);padding:.18rem .4rem;
      background:var(--paper-2);border-radius:4px;letter-spacing:0;
    }

    .card-actions{display:flex;gap:.35rem;flex-shrink:0}

    /* ── Buttons ── */
    .btn{
      display:inline-flex;align-items:center;gap:.4rem;
      padding:.5rem .85rem;border-radius:6px;
      font-family:var(--font-body);font-size:13px;font-weight:500;
      letter-spacing:-.003em;cursor:pointer;
      border:1px solid transparent;text-decoration:none;
      transition:background 140ms,border-color 140ms,color 140ms,transform 140ms,opacity 140ms;
      line-height:1.3;
    }
    .btn svg{width:13px;height:13px;flex-shrink:0}
    .btn-sm{padding:.38rem .65rem;font-size:12.5px}
    .btn:disabled{opacity:.45;cursor:not-allowed}
    .btn-ghost{background:var(--paper-card);color:var(--ink-2);border-color:var(--line)}
    .btn-ghost:hover:not(:disabled){background:var(--paper-2);border-color:var(--ink);color:var(--ink)}
    .btn-confirm{background:var(--create);color:#fff;border-color:var(--create)}
    .btn-confirm:hover:not(:disabled){background:#3e6b2d;border-color:#3e6b2d}
    .btn-discard{background:var(--paper-card);color:var(--delete);border-color:color-mix(in srgb,var(--delete) 35%,var(--line))}
    .btn-discard:hover:not(:disabled){background:var(--delete-soft);border-color:var(--delete)}

    /* ── Diff ── */
    .diff{
      margin-top:.95rem;border:1px solid var(--line);border-radius:8px;
      background:var(--paper);overflow:hidden;
      font-family:var(--font-mono);font-size:12.5px;
    }
    .diff-head{
      display:grid;grid-template-columns:minmax(140px,1.2fr) 1fr 28px 1fr;
      gap:.5rem;align-items:center;
      padding:.45rem .9rem;
      background:var(--paper-2);border-bottom:1px solid var(--line);
      font-size:10px;font-weight:600;letter-spacing:.08em;
      text-transform:uppercase;color:var(--ink-4);font-family:var(--font-body);
    }
    .dh-after{color:var(--ink-3)}
    .diff-row{
      display:grid;grid-template-columns:minmax(140px,1.2fr) 1fr 28px 1fr;
      gap:.5rem;align-items:start;
      padding:.55rem .9rem;border-bottom:1px solid var(--line);
    }
    .diff-row:last-child{border-bottom:none}
    .d-field{color:var(--ink-2);font-weight:500;word-break:break-word}
    .d-before{
      color:var(--delete);background:var(--delete-soft);
      padding:.18rem .45rem;border-radius:4px;
      text-decoration:line-through;text-decoration-color:color-mix(in srgb,var(--delete) 60%,transparent);
      word-break:break-word;line-height:1.5;
    }
    .d-arrow{
      color:var(--ink-4);text-align:center;
      font-family:var(--font-body);font-size:14px;padding-top:.18rem;
    }
    .d-after{
      color:var(--create);background:var(--create-soft);
      padding:.18rem .45rem;border-radius:4px;
      font-weight:500;word-break:break-word;line-height:1.5;
    }

    .raw-block{margin-top:.95rem;border:1px solid var(--line);border-radius:8px;overflow:hidden}
    .raw-block summary{
      padding:.55rem .9rem;background:var(--paper-2);
      font-size:11.5px;font-weight:500;color:var(--ink-3);
      cursor:pointer;user-select:none;list-style:none;
      display:flex;align-items:center;gap:.4rem;
    }
    .raw-block summary::-webkit-details-marker{display:none}
    .raw-block summary::before{
      content:'▸';color:var(--ink-4);font-size:10px;transition:transform 120ms;
    }
    .raw-block[open] summary::before{transform:rotate(90deg)}
    .raw-block pre{
      background:var(--ink);color:#f4efe4;
      padding:.85rem 1rem;font-family:var(--font-mono);
      font-size:12px;line-height:1.55;overflow-x:auto;
    }

    /* ── Status ── */
    .status{
      display:none;margin-top:.7rem;
      padding:.55rem .85rem;border-radius:6px;
      font-size:12.5px;font-weight:500;
      align-items:center;gap:.45rem;
      animation:status-in 240ms cubic-bezier(.2,.6,.3,1);
    }
    .status.show{display:flex}
    .status svg{width:14px;height:14px;flex-shrink:0}
    .status.ok{background:var(--create-soft);color:var(--create);border:1px solid color-mix(in srgb,var(--create) 25%,transparent)}
    .status.err{background:var(--delete-soft);color:var(--delete);border:1px solid color-mix(in srgb,var(--delete) 25%,transparent)}
    .status.neutral{background:var(--paper-2);color:var(--ink-3);border:1px solid var(--line)}
    @keyframes status-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}

    /* ── Empty state ── */
    .empty-state{
      text-align:center;padding:4rem 2rem;
      background:var(--paper-card);border:1px solid var(--line);
      border-radius:12px;box-shadow:var(--shadow-1);
    }
    .empty-glyph{color:var(--ink-4);margin-bottom:1rem}
    .empty-glyph svg{width:42px;height:42px;margin:0 auto;display:block}
    .empty-title{
      font-family:var(--font-display);font-style:italic;font-weight:400;
      font-size:22px;color:var(--ink);letter-spacing:-.015em;margin-bottom:.4rem;
    }
    .empty-msg{font-size:13.5px;color:var(--ink-3);max-width:320px;margin:0 auto;line-height:1.55}

    /* ── Confirm-removed (post-action) ── */
    .card.removed{
      opacity:.55;
      filter:saturate(.6);
    }
    .card.removed .card-actions{pointer-events:none;opacity:.5}

    /* ── Mobile ── */
    @media (max-width:680px){
      .page{padding:1.25rem 1rem}
      .head{margin-bottom:1.25rem}
      .card{padding:1rem}
      .card-actions{width:100%;justify-content:flex-end}
      .btn-sm span{display:none}
      .btn-sm{padding:.5rem}
      .diff-head,.diff-row{
        grid-template-columns:1fr;gap:.3rem;
      }
      .dh-arrow,.d-arrow{display:none}
      .dh-cell.dh-field{font-size:10px;color:var(--ink-4)}
      .dh-cell:not(.dh-field){display:none}
      .d-field{padding-top:.25rem;font-weight:600;color:var(--ink)}
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="head">
      <div class="brand">
        <div class="brand-mark">a</div>
        <div class="brand-text">
          <div class="brand-eyebrow">Atelier · Vorschau</div>
          <h1 class="brand-title">${found ? (allPreviews.length === 1 ? "Eine <em>Änderung</em> prüfen" : `<em>${allPreviews.length}</em> Änderungen prüfen`) : "Keine <em>Änderung</em>"}</h1>
          ${found ? `<div class="summary">${summaryBits.join("")}</div>` : ""}
        </div>
      </div>
      <div class="head-spacer"></div>
      <a href="${escHtml(previewBaseUrl)}" class="live-link" target="_blank" rel="noopener">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9.5l4.5-4.5M5.5 5H10v4.5"/></svg>
        Live-Vorschau
      </a>
    </div>
    ${bulkBar}
    ${cards}
  </div>
  <script>
    const API = ${JSON.stringify(apiBase)};
    const TOKENS = ${JSON.stringify(allPreviews.map((p) => p.preview_token))};
    const FOCUS = ${JSON.stringify(focusToken || "")};

    const SVG_OK = '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l3 3 5-6"/></svg>';
    const SVG_X  = '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg>';
    const SVG_E  = '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="5.5"/><path d="M7 4.5v3M7 10h0"/></svg>';

    function setStatus(el, kind, msg, icon) {
      if (!el) return;
      el.classList.add('show');
      el.classList.remove('ok','err','neutral');
      el.classList.add(kind);
      el.innerHTML = (icon || '') + '<span>' + msg + '</span>';
    }

    function markRemoved(token, ok) {
      const card = document.getElementById('card-' + token);
      if (!card) return;
      card.classList.add('removed');
    }

    async function act(url, method, statusId, okMsg, okKind, token) {
      const el = document.getElementById(statusId);
      try {
        const r = await fetch(url, { method });
        if (r.ok) {
          setStatus(el, okKind || 'ok', okMsg, okKind === 'neutral' ? SVG_X : SVG_OK);
          markRemoved(token, true);
        } else {
          setStatus(el, 'err', 'Fehler (' + r.status + ')', SVG_E);
        }
      } catch (e) {
        setStatus(el, 'err', 'Netzwerkfehler', SVG_E);
      }
    }

    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-confirm],button[data-discard],#confirm-all,#discard-all');
      if (!btn || btn.disabled) return;
      btn.disabled = true;

      if (btn.id === 'confirm-all') {
        const el = document.getElementById('s-all');
        const results = await Promise.allSettled(TOKENS.map(t => fetch(API + '/confirm/' + t, { method: 'POST' })));
        const okCount = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
        TOKENS.forEach(t => markRemoved(t, true));
        setStatus(el, okCount === TOKENS.length ? 'ok' : 'err',
          okCount === TOKENS.length ? 'Alle ' + okCount + ' Änderungen übernommen.' : okCount + ' von ' + TOKENS.length + ' übernommen.',
          SVG_OK);
      } else if (btn.id === 'discard-all') {
        const el = document.getElementById('s-all');
        await Promise.allSettled(TOKENS.map(t => fetch(API + '/preview/' + t, { method: 'DELETE' })));
        TOKENS.forEach(t => markRemoved(t, false));
        setStatus(el, 'neutral', 'Alle Änderungen verworfen.', SVG_X);
      } else if (btn.dataset.confirm) {
        await act(API + '/confirm/' + btn.dataset.confirm, 'POST', 's-' + btn.dataset.confirm, 'Übernommen und gespeichert.', 'ok', btn.dataset.confirm);
      } else if (btn.dataset.discard) {
        await act(API + '/preview/' + btn.dataset.discard, 'DELETE', 's-' + btn.dataset.discard, 'Verworfen.', 'neutral', btn.dataset.discard);
      }
    });

    // Scroll focused card into view
    if (FOCUS) {
      const el = document.getElementById('card-' + FOCUS);
      if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
    }
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
/* Atelier preview banner — scoped, no host-page conflicts */
#pb-root{position:fixed!important;bottom:0!important;left:0!important;right:0!important;z-index:2147483646!important;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif!important;font-size:13px!important;line-height:1.4!important;color:#1a1816!important;letter-spacing:-.003em!important;pointer-events:none}
#pb-root *{box-sizing:border-box!important}
#pb-root>*{pointer-events:auto}
#pb-float{position:fixed!important;z-index:2147483645!important;display:none;align-items:center;gap:4px;background:#1a1816!important;border-radius:8px!important;padding:5px 6px 5px 12px!important;box-shadow:0 12px 32px -8px rgba(0,0,0,.4),0 4px 12px -4px rgba(0,0,0,.25)!important;pointer-events:auto;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif!important;font-size:12px!important;line-height:1.4!important;animation:pb-fl-in 160ms cubic-bezier(.2,.6,.3,1)}
.pb-fl{font-family:ui-serif,"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif!important;font-style:italic!important;font-weight:400!important;font-size:13px!important;color:#faf8f3!important;padding:0 6px 0 0!important;margin-right:2px!important;white-space:nowrap!important;letter-spacing:-.01em!important;border-right:1px solid rgba(244,239,228,.16)!important}
.pb-fb{border:none!important;border-radius:5px!important;padding:5px 10px!important;cursor:pointer!important;font-size:12px!important;font-weight:500!important;font-family:inherit!important;color:#fff!important;white-space:nowrap!important;line-height:1.4!important;display:inline-flex!important;align-items:center!important;gap:4px!important;transition:transform 120ms,filter 120ms,opacity 120ms!important;letter-spacing:-.003em!important}
.pb-fb:hover{filter:brightness(1.12)!important;transform:translateY(-1px)!important}
.pb-fb:active{transform:translateY(0)!important}
.pb-fb:disabled{opacity:.5!important;cursor:not-allowed!important;transform:none!important}
.pb-fb svg{width:11px!important;height:11px!important}
.pb-fc{background:#3e6b2d!important}
.pb-fd{background:transparent!important;color:rgba(244,239,228,.6)!important;padding:5px 8px!important}
.pb-fd:hover{color:#f4efe4!important;background:rgba(244,239,228,.08)!important;filter:none!important}
@keyframes pb-fl-in{from{opacity:0;transform:translateY(-4px) scale(.97)}to{opacity:1;transform:none}}

/* Highlighted elements */
.pb-mark,.pb-anchor,.pb-field{position:relative!important;z-index:1!important;cursor:pointer!important;transition:filter 140ms,box-shadow 140ms!important}
.pb-mark{background:#fae9e0!important;color:#1a1816!important;outline:2px solid #b8401b!important;outline-offset:2px!important;border-radius:3px!important;padding:1px 4px!important;margin:0 2px!important;-webkit-box-decoration-break:clone!important;box-decoration-break:clone!important;display:inline!important;font-weight:500!important;animation:pb-glow 2.6s ease-in-out infinite!important}
.pb-mark[data-pb-action=create]{background:#e6efd9!important;outline-color:#4f7a3a!important;animation-name:pb-glow-c!important}
.pb-mark[data-pb-action=update_singleton]{background:#dde9f3!important;outline-color:#2e5d8a!important;animation-name:pb-glow-s!important}
.pb-mark[data-pb-action=delete]{background:#fadbd7!important;outline-color:#b32d23!important;text-decoration:line-through!important;animation-name:pb-glow-d!important}

.pb-anchor{outline:2px dashed #b8401b!important;outline-offset:5px!important;border-radius:6px!important;animation:pb-glow 2.6s ease-in-out infinite!important}
.pb-anchor[data-pb-action=create]{outline-color:#4f7a3a!important;animation-name:pb-glow-c!important}
.pb-anchor[data-pb-action=update_singleton]{outline-color:#2e5d8a!important;animation-name:pb-glow-s!important}
.pb-anchor[data-pb-action=delete]{outline-color:#b32d23!important;animation-name:pb-glow-d!important}

.pb-field{outline:2px solid #b8401b!important;outline-offset:3px!important;border-radius:4px!important;background-color:rgba(184,64,27,.06)!important;animation:pb-glow 2.6s ease-in-out infinite!important}
.pb-field[data-pb-anchor]{outline-style:dashed!important;background-color:transparent!important;outline-offset:5px!important}
.pb-field[data-pb-action=create]{outline-color:#4f7a3a!important;background-color:rgba(79,122,58,.07)!important;animation-name:pb-glow-c!important}
.pb-field[data-pb-action=update_singleton]{outline-color:#2e5d8a!important;background-color:rgba(46,93,138,.07)!important;animation-name:pb-glow-s!important}
.pb-field[data-pb-action=delete]{outline-color:#b32d23!important;background-color:rgba(179,45,35,.07)!important;text-decoration:line-through!important;animation-name:pb-glow-d!important}
.pb-mark:hover,.pb-anchor:hover,.pb-field:hover{filter:brightness(1.04)!important}

@keyframes pb-glow{0%,100%{box-shadow:0 0 0 1px rgba(184,64,27,.18),0 1px 4px rgba(184,64,27,.08)}50%{box-shadow:0 0 0 4px rgba(184,64,27,.18),0 4px 14px rgba(184,64,27,.16)}}
@keyframes pb-glow-c{0%,100%{box-shadow:0 0 0 1px rgba(79,122,58,.18),0 1px 4px rgba(79,122,58,.08)}50%{box-shadow:0 0 0 4px rgba(79,122,58,.18),0 4px 14px rgba(79,122,58,.16)}}
@keyframes pb-glow-s{0%,100%{box-shadow:0 0 0 1px rgba(46,93,138,.18),0 1px 4px rgba(46,93,138,.08)}50%{box-shadow:0 0 0 4px rgba(46,93,138,.18),0 4px 14px rgba(46,93,138,.16)}}
@keyframes pb-glow-d{0%,100%{box-shadow:0 0 0 1px rgba(179,45,35,.18),0 1px 4px rgba(179,45,35,.08)}50%{box-shadow:0 0 0 4px rgba(179,45,35,.18),0 4px 14px rgba(179,45,35,.16)}}

@keyframes pb-p{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.85)}}
@keyframes pb-slide-in{from{transform:translateY(100%);opacity:0}to{transform:none;opacity:1}}
@keyframes pb-rows-in{from{max-height:0;opacity:0}to{max-height:320px;opacity:1}}
</style>
<div id="pb-root"></div>
<div id="pb-float"><span class="pb-fl" id="pb-fl"></span><button class="pb-fb pb-fc" id="pb-fc"><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l3 3 5-6"/></svg>Übernehmen</button><button class="pb-fb pb-fd" id="pb-fd"><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg>Verwerfen</button></div>
<script>
(function(){
  if(window.__pbLoaded)return;
  window.__pbLoaded=true;

  var MCP=${mcp};
  var previews=[],open=false,bound=false,hlBound=false,curToken=null,pbFocusDone=false,hlIndex=-1;
  var pbFloat,pbFl,pbFc,pbFd,pbHideT=null;

  var ACT={create:'Neu',update:'Änderung',update_singleton:'Aktualisierung',delete:'Löschung'};
  var COL={
    create:{bg:'#e6efd9',fg:'#3e6b2d',br:'rgba(79,122,58,.3)'},
    update:{bg:'#fae9e0',fg:'#9a3414',br:'rgba(184,64,27,.3)'},
    update_singleton:{bg:'#dde9f3',fg:'#264f76',br:'rgba(46,93,138,.3)'},
    delete:{bg:'#fadbd7',fg:'#94251c',br:'rgba(179,45,35,.3)'}
  };

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

  function cancelHide(){if(pbHideT){clearTimeout(pbHideT);pbHideT=null;}}
  function showFloat(el,token,action){
    if(!pbFloat||!pbFl)return;
    cancelHide();
    curToken=token;
    pbFl.textContent=el.dataset.pbAnchor?'Änderung':(ACT[action]||action);
    /* Render off-screen first so we can measure the card's size, then position
       it outside the element so it never covers the changed text. */
    pbFloat.style.left='-9999px';
    pbFloat.style.right='auto';
    pbFloat.style.top='0px';
    pbFloat.style.display='flex';
    var r=el.getBoundingClientRect();
    var fw=pbFloat.offsetWidth||0,fh=pbFloat.offsetHeight||0,gap=6;
    var top=r.top-fh-gap;
    if(top<4)top=Math.min(window.innerHeight-fh-4,r.bottom+gap);
    if(top<4)top=4;
    var right=Math.max(4,window.innerWidth-r.right);
    if(right+fw>window.innerWidth-4)right=Math.max(4,window.innerWidth-fw-4);
    pbFloat.style.top=top+'px';
    pbFloat.style.right=right+'px';
    pbFloat.style.left='auto';
  }
  function hideFloat(){cancelHide();if(pbFloat)pbFloat.style.display='none';curToken=null;}
  function delayedHide(){cancelHide();pbHideT=setTimeout(function(){pbHideT=null;hideFloat();},140);}

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
      if(el){showFloat(el,el.dataset.pbToken,el.dataset.pbAction);return;}
      if(pbFloat&&e.target&&(e.target===pbFloat||pbFloat.contains(e.target)))cancelHide();
    });
    document.addEventListener('mouseout',function(e){
      var rt=e.relatedTarget;
      if(rt&&rt.closest&&(rt.closest('.pb-field')||(pbFloat&&(rt===pbFloat||pbFloat.contains(rt)))))return;
      delayedHide();
    });
    if(pbFloat){
      pbFloat.addEventListener('mouseover',cancelHide);
      pbFloat.addEventListener('mouseout',function(e){
        var rt=e.relatedTarget;
        if(rt&&(rt.closest&&rt.closest('.pb-field')||pbFloat.contains(rt)))return;
        delayedHide();
      });
    }
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
  function badge(p){
    var c=COL[p.action]||COL.update;
    return'<span style="display:inline-flex!important;align-items:center!important;gap:4px!important;background:'+c.bg+'!important;color:'+c.fg+'!important;border:1px solid '+c.br+'!important;padding:2px 8px 2px 6px!important;border-radius:99px!important;font-family:ui-monospace,SFMono-Regular,Menlo,monospace!important;font-size:10px!important;font-weight:500!important;text-transform:uppercase!important;letter-spacing:.07em!important;white-space:nowrap!important;line-height:1.45!important"><span style="width:5px;height:5px;border-radius:50%;background:'+c.fg+';display:inline-block"></span>'+(ACT[p.action]||p.action)+'</span>';
  }

  /* Style helpers (inline because of host-site CSS resets) */
  var BAR_BG='#faf8f3',BAR_BORDER='#e7e1d0',ACCENT='#b8401b',ACCENT_DK='#9a3414',INK='#1a1816',INK_2='#3d3a35',INK_3='#6b6660',INK_4='#9c958a';

  function navButton(label,key){
    return'<button data-pb="'+key+'" style="display:inline-flex!important;align-items:center!important;justify-content:center!important;width:26px!important;height:26px!important;padding:0!important;background:#fff!important;color:'+INK_2+'!important;border:1px solid '+BAR_BORDER+'!important;border-radius:6px!important;cursor:pointer!important;font-family:inherit!important;line-height:1!important;transition:background 120ms,border-color 120ms,color 120ms!important"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="width:11px!important;height:11px!important">'+label+'</svg></button>';
  }

  function buildHTML(){
    var n=previews.length,lbl=n===1?'1 Änderung':n+' Änderungen';
    var hlN=markedTokens().length;
    var navHtml=hlN>0
      ?'<span style="display:inline-flex!important;align-items:center!important;gap:4px!important;padding-left:8px!important;margin-left:4px!important;border-left:1px solid '+BAR_BORDER+'!important">'
        +navButton('<path d="M7.5 2.5L4 6l3.5 3.5"/>','prev')
        +'<span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace!important;font-size:11px!important;font-weight:500!important;color:'+INK_3+'!important;min-width:42px!important;text-align:center!important;padding:0 4px!important;font-variant-numeric:tabular-nums!important;letter-spacing:0!important">'
          +(hlIndex>=0?(hlIndex+1)+' / '+hlN:hlN+' Markierungen')
        +'</span>'
        +navButton('<path d="M4.5 2.5L8 6l-3.5 3.5"/>','next')
        +'</span>'
      :'';

    var rows=open?'<div id="pb-rows" style="background:#fff!important;border-top:1px solid '+BAR_BORDER+'!important;max-height:320px!important;overflow-y:auto!important;animation:pb-rows-in 240ms cubic-bezier(.2,.6,.3,1)!important">'
      +previews.map(function(p,i){
        var otherPages=(p.preview_pages||[]).filter(function(pg){return pg!==location.pathname;});
        var jumpLinks=otherPages.map(function(pg){
          var lbl=pg==='/'?'Startseite':pg.slice(1).charAt(0).toUpperCase()+pg.slice(2);
          return'<a href="'+escH(pg)+'?pb_focus='+escH(p.preview_token)+'" style="display:inline-flex!important;align-items:center!important;gap:3px!important;padding:3px 8px!important;background:#fff!important;color:'+INK_2+'!important;border:1px solid '+BAR_BORDER+'!important;border-radius:5px!important;font-size:11.5px!important;font-weight:500!important;text-decoration:none!important;white-space:nowrap!important;line-height:1.3!important;font-family:inherit!important"><svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="width:9px!important;height:9px!important"><path d="M3.5 6.5l3-3M4 3.5h3v3"/></svg>'+escH(lbl)+'</a>';
        }).join('');
        var idTxt=p.id!=null?' #'+escH(String(p.id)):(p.ids?' ('+p.ids.length+')':'');
        return'<div style="display:flex!important;align-items:center!important;gap:10px!important;padding:10px 18px!important;border-bottom:1px solid '+BAR_BORDER+'!important;font-size:12.5px!important;flex-wrap:wrap!important;line-height:1.4!important;background:'+(i%2===0?'transparent':'#faf8f3')+'!important">'
          +badge(p)
          +'<span style="font-weight:500!important;color:'+INK+'!important;white-space:nowrap!important;letter-spacing:-.003em!important">'+escH(p.collection)+'<span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace!important;color:'+INK_4+'!important;font-weight:500!important;font-size:11.5px!important">'+escH(idTxt)+'</span></span>'
          +'<span style="color:'+INK_3+'!important;flex:1!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;min-width:0!important;font-family:ui-monospace,SFMono-Regular,Menlo,monospace!important;font-size:11.5px!important">'+escH(diffText(p))+'</span>'
          +jumpLinks
          +'<button data-pb="confirm-one" data-token="'+escH(p.preview_token)+'" style="display:inline-flex!important;align-items:center!important;gap:4px!important;padding:4px 9px!important;background:#3e6b2d!important;color:#fff!important;border:none!important;border-radius:5px!important;cursor:pointer!important;font-size:11.5px!important;font-weight:500!important;font-family:inherit!important;line-height:1.3!important;letter-spacing:-.003em!important"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:10px!important;height:10px!important"><path d="M2.5 6l2.5 2.5L9.5 3"/></svg>Übernehmen</button>'
          +'<button data-pb="discard-one" data-token="'+escH(p.preview_token)+'" style="display:inline-flex!important;align-items:center!important;gap:4px!important;padding:4px 9px!important;background:#fff!important;color:'+INK_3+'!important;border:1px solid '+BAR_BORDER+'!important;border-radius:5px!important;cursor:pointer!important;font-size:11.5px!important;font-weight:500!important;font-family:inherit!important;line-height:1.3!important;letter-spacing:-.003em!important">Verwerfen</button>'
          +'</div>';
      }).join('')+'</div>':'';

    return rows
      +'<div style="background:'+BAR_BG+'!important;border-top:1px solid '+BAR_BORDER+'!important;border-bottom:3px solid '+ACCENT+'!important;padding:10px 18px!important;display:flex!important;align-items:center!important;gap:10px!important;flex-wrap:wrap!important;animation:pb-slide-in 320ms cubic-bezier(.2,.6,.3,1)!important;box-shadow:0 -8px 24px -8px rgba(26,24,22,.18),0 -2px 8px -2px rgba(26,24,22,.08)!important">'
      +'<span style="display:inline-flex!important;align-items:center!important;gap:8px!important;line-height:1!important">'
        +'<span style="display:inline-flex!important;align-items:center!important;justify-content:center!important;width:24px!important;height:24px!important;border-radius:50%!important;background:'+INK+'!important;color:'+BAR_BG+'!important;font-family:ui-serif,\"Iowan Old Style\",\"Palatino Linotype\",Palatino,Georgia,serif!important;font-style:italic!important;font-weight:500!important;font-size:14px!important;letter-spacing:-.02em!important">a</span>'
        +'<span style="position:relative!important;display:inline-flex!important;align-items:center!important">'
          +'<span style="width:7px!important;height:7px!important;border-radius:50%!important;background:'+ACCENT+'!important;animation:pb-p 1.6s ease-in-out infinite!important;flex-shrink:0!important;margin-right:8px!important;box-shadow:0 0 0 4px '+ACCENT+'22!important"></span>'
          +'<span style="font-family:ui-serif,\"Iowan Old Style\",\"Palatino Linotype\",Palatino,Georgia,serif!important;font-style:italic!important;font-weight:400!important;font-size:15px!important;color:'+INK+'!important;letter-spacing:-.015em!important">Vorschau</span>'
          +'<span style="margin-left:8px!important;font-family:ui-monospace,SFMono-Regular,Menlo,monospace!important;font-size:11px!important;font-weight:500!important;color:'+INK_3+'!important;padding:2px 7px!important;background:#fff!important;border:1px solid '+BAR_BORDER+'!important;border-radius:99px!important;letter-spacing:0!important;font-variant-numeric:tabular-nums!important">'+escH(lbl)+'</span>'
        +'</span>'
      +'</span>'
      +navHtml
      +'<button data-pb="toggle" style="padding:5px 11px!important;background:transparent!important;border:1px solid '+BAR_BORDER+'!important;border-radius:99px!important;cursor:pointer!important;font-family:inherit!important;font-size:11.5px!important;font-weight:500!important;color:'+INK_2+'!important;line-height:1.3!important;display:inline-flex!important;align-items:center!important;gap:5px!important;transition:background 120ms,border-color 120ms!important;letter-spacing:-.003em!important"><svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:9px!important;height:9px!important;transition:transform 160ms!important;transform:'+(open?'rotate(180deg)':'none')+'"><path d="M2.5 6.5l2.5-3 2.5 3"/></svg>'+(open?'Schließen':'Details')+'</button>'
      +'<div style="margin-left:auto!important;display:flex!important;gap:6px!important;align-items:center!important">'
        +'<button data-pb="discard-all" style="display:inline-flex!important;align-items:center!important;gap:5px!important;padding:6px 12px!important;background:#fff!important;color:'+INK_2+'!important;border:1px solid '+BAR_BORDER+'!important;border-radius:6px!important;cursor:pointer!important;font-family:inherit!important;font-size:12.5px!important;font-weight:500!important;line-height:1.3!important;letter-spacing:-.003em!important;transition:background 120ms,border-color 120ms!important">Alle verwerfen</button>'
        +'<button data-pb="confirm-all" style="display:inline-flex!important;align-items:center!important;gap:5px!important;padding:6px 12px!important;background:'+INK+'!important;color:'+BAR_BG+'!important;border:1px solid '+INK+'!important;border-radius:6px!important;cursor:pointer!important;font-family:inherit!important;font-size:12.5px!important;font-weight:500!important;line-height:1.3!important;letter-spacing:-.003em!important;transition:background 120ms,transform 120ms!important;box-shadow:0 1px 2px rgba(26,24,22,.12)!important"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:11px!important;height:11px!important"><path d="M2.5 6l2.5 2.5L9.5 3"/></svg>Alle übernehmen</button>'
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
    /* Measure actual banner height so host-page content never gets covered */
    var h=root.offsetHeight||60;
    document.body.style.paddingBottom=h+'px';
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
          const token = await storePreview(entry);
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
          const token = await storePreview(entry);
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
            staged.push({ token: await storePreview(entry), entry });
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
          const token = await storePreview(entry);
          return text(buildPreviewResponse(token, entry));
        }

        case "delete_item": {
          const { collection, id } = args as { collection: string; id: string | number };
          const res = await client.readItem(collection, id) as { data: Record<string, unknown> };
          const entry: PreviewEntry = {
            session_id: sessionId, action: "delete", collection, id, before: res.data,
          };
          const token = await storePreview(entry);
          return text(buildPreviewResponse(token, entry));
        }

        case "confirm_preview": {
          const { token } = args as { token: string };
          const row = await db.getPreview(token);
          if (!row || row.session_id !== sessionId) {
            return err("Preview not found — it may have already been confirmed or discarded.");
          }
          const entry = rowToEntry(row);
          await db.deletePreview(token);
          await applyEntry(client, entry);
          return text(`✓ Done. ${entry.action} on ${entry.collection}${entry.id != null ? ` #${entry.id}` : ""} has been written to Directus.`);
        }

        case "discard_preview": {
          const { token } = args as { token: string };
          const row = await db.getPreview(token);
          if (!row || row.session_id !== sessionId) {
            return err("Preview not found — it may have already been confirmed or discarded.");
          }
          await db.deletePreview(token);
          return text(`✗ Discarded. Nothing was written to Directus.`);
        }

        case "list_previews": {
          const ours = await previewsForSession(sessionId);
          if (ours.length === 0) return text("No staged changes.");
          const lines = ours.map(({ token, entry }) => {
            const diff = entry.diff?.map((d) => `${d.field}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`).join(", ") ?? "";
            return `- [${entry.action}] ${entry.collection}${entry.id != null ? ` #${entry.id}` : ""}${diff ? `  (${diff})` : ""}  token: ${token}`;
          });
          return text(`Staged changes (${ours.length}):\n${lines.join("\n")}`);
        }

        case "confirm_all_previews": {
          const ours = await previewsForSession(sessionId);
          if (!ours.length) return text("No staged changes to confirm.");
          for (const { token, entry } of ours) {
            await db.deletePreview(token);
            await applyEntry(client, entry);
          }
          return text(`✓ All ${ours.length} change(s) confirmed and written to Directus.`);
        }

        case "discard_all_previews": {
          const ours = await previewsForSession(sessionId);
          if (!ours.length) return text("No staged changes to discard.");
          await db.deletePreviewsForSession(sessionId);
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
      const { id: sessionId, info } = await getOrCreateSession(req);

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
      const entries = (await previewsForSession(sid)).map(({ token, entry }) => ({
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
      const row = await db.getPreview(token);
      const valid = !!row && row.session_id === sid;
      if (method === "GET") {
        if (!valid) { res.writeHead(404, { "Content-Type": "application/json", ...CORS_HEADERS }).end(JSON.stringify({ error: "Preview not found" })); return; }
        res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
          .end(JSON.stringify({ ...rowToEntry(row!), preview_token: token }));
        return;
      }
      if (method === "DELETE") {
        if (valid) await db.deletePreview(token);
        res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS }).end(JSON.stringify({ success: true }));
        return;
      }
    }

    // ── POST /sessions/:sid/confirm/:token ─────────────────────────────────
    const sessionConfirmMatch = /^\/sessions\/([^/]+)\/confirm\/([^/]+)$/.exec(path);
    if (method === "POST" && sessionConfirmMatch) {
      const sid = decodeURIComponent(sessionConfirmMatch[1]!);
      const token = decodeURIComponent(sessionConfirmMatch[2]!);
      const row = await db.getPreview(token);
      if (!row || row.session_id !== sid) {
        res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
          .end(JSON.stringify({ success: true, alreadyApplied: true }));
        return;
      }
      const entry = rowToEntry(row);
      await db.deletePreview(token);
      const sessionRow = await db.getSession(sid);
      const info: SessionInfo = sessionRow ? rowToInfo(sessionRow) : { directusUrl: "" };
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
      const previews = (await previewsForSession(sid)).map(({ token: t, entry }) => ({ ...entry, preview_token: t }));
      const html = buildReviewPage(sid, token, previews);
      const row = await db.getPreview(token);
      const status = row && row.session_id === sid ? 200 : 404;
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

db.initSchema()
  .then(() => process.stderr.write(`[db] schema ready\n`))
  .catch((e: unknown) => {
    process.stderr.write(`[db] init failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
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
    const sessionRow = await db.getSession(sid);
    if (!sessionRow || !sessionRow.website_url) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<h1>404 — Unknown preview session</h1><p>No website URL configured for session <code>${escHtml(sid)}</code>.</p>`);
      return;
    }
    await db.touchSession(sid);

    const url = new URL(req.url ?? "/", `http://localhost:${PREVIEW_PROXY_PORT}`);
    const targetBase = sessionRow.website_url.replace(/\/$/, "");
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
      html = await applyPreviewsToHtml(html, sid);
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
