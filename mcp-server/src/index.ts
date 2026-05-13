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

// ── Per-request client factory ────────────────────────────────────────────────
//
// Connection details may be supplied per request via HTTP headers, falling back
// to env vars. This lets a single MCP server serve multiple Directus instances
// (the chat-app uses this to switch between connection profiles).

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function makeClient(req: http.IncomingMessage): DirectusClient {
  const opts: DirectusClientOpts = {
    url:      header(req, "x-directus-url")      ?? process.env.DIRECTUS_URL      ?? "http://localhost:8055",
    token:    header(req, "x-directus-token")    ?? process.env.DIRECTUS_TOKEN,
    email:    header(req, "x-directus-email")    ?? process.env.DIRECTUS_EMAIL,
    password: header(req, "x-directus-password") ?? process.env.DIRECTUS_PASSWORD,
  };
  return new DirectusClient(opts);
}

const WEBSITE_URL = (process.env.WEBSITE_URL ?? "http://localhost:4321").replace(/\/$/, "");
const DIRECTUS_UPSTREAM = (process.env.DIRECTUS_URL ?? "http://localhost:8055").replace(/\/$/, "");
const MCP_PUBLIC_URL = (process.env.MCP_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3001}`).replace(/\/$/, "");
const PREVIEW_PROXY_PORT = Number(process.env.PREVIEW_PROXY_PORT ?? 4322);
const PREVIEW_WEBSITE_URL = (process.env.PREVIEW_WEBSITE_URL ?? `http://localhost:${PREVIEW_PROXY_PORT}`).replace(/\/$/, "");
const PREVIEW_WEBSITE_INTERNAL_URL = (process.env.PREVIEW_WEBSITE_INTERNAL_URL ?? "http://localhost:4321").replace(/\/$/, "");

// Maps Directus collections to the website page that renders them.
// Used to build the "jump to preview" link on the review page.
const COLLECTION_PAGES: Record<string, string> = {
  menu_items: "/speisekarte",
  categories: "/speisekarte",
  speisekarte_copy: "/speisekarte",
  events: "/events",
  team: "/ueber-uns",
  about: "/ueber-uns",
  ueber_uns_copy: "/ueber-uns",
  faq_items: "/faq",
  faq_copy: "/faq",
  kontakt_copy: "/kontakt",
  opening_hours: "/kontakt",
};

function previewPageForCollection(collection: string): string {
  return COLLECTION_PAGES[collection] ?? "/";
}

/** Tool schema hint: Directus returns HTTP 403 for invalid /items/.../id paths (easy to mistake for RBAC). */
const ITEM_PK_DESCRIPTION =
  "Exact primary key from read_items/read_item (integer or UUID). Never a title, slug, or placeholder; if you only know a name, call read_items with a filter first, then use data[0].id.";

// ── Preview store ─────────────────────────────────────────────────────────────

interface PreviewEntry {
  action: "create" | "update" | "delete" | "update_singleton";
  collection: string;
  id?: string | number;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  diff?: DiffEntry[];
  data?: Record<string, unknown>;
}

const previewStore = new Map<string, { entry: PreviewEntry; timer: ReturnType<typeof setTimeout> }>();
const PREVIEW_TTL_MS = 30 * 60 * 1000;

function storePreview(entry: PreviewEntry): string {
  const token = randomUUID();
  const timer = setTimeout(() => previewStore.delete(token), PREVIEW_TTL_MS);
  previewStore.set(token, { entry, timer });
  return token;
}

function buildPreviewResponse(token: string, entry: PreviewEntry): string {
  const preview_url = PREVIEW_WEBSITE_URL;
  const review_url = `${MCP_PUBLIC_URL}/review/${token}`;
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
    `Only after ALL changes are staged, show the user this summary:`,
    `  Preview (live site): ${preview_url}`,
    `  Review all changes:  ${review_url}`,
    `Then ask the user to confirm or discard. Use confirm_all_previews / discard_all_previews for bulk, or confirm_preview / discard_preview per token.`,
  ].join("\n");
}

// ── Proxy helpers ─────────────────────────────────────────────────────────────

function applyPreviewsToResponse(body: unknown, collection: string): unknown {
  if (!body || typeof body !== "object") return body;
  const b = body as { data: unknown };

  if (Array.isArray(b.data)) {
    let items = b.data as unknown[];
    for (const { entry } of previewStore.values()) {
      if (entry.collection !== collection) continue;
      switch (entry.action) {
        case "create":
          items = [...items, { ...entry.after, id: "__preview_new__" }];
          break;
        case "update":
          if (entry.id != null) {
            items = items.map((item) => {
              const i = item as Record<string, unknown>;
              return String(i["id"]) === String(entry.id) ? { ...i, ...entry.data } : i;
            });
          }
          break;
        case "delete":
          if (entry.id != null) {
            items = items.filter((item) => {
              const i = item as Record<string, unknown>;
              return String(i["id"]) !== String(entry.id);
            });
          }
          break;
      }
    }
    return { ...b, data: items };
  }

  if (b.data && typeof b.data === "object" && !Array.isArray(b.data)) {
    let data = b.data as Record<string, unknown>;
    for (const { entry } of previewStore.values()) {
      if (entry.collection !== collection) continue;
      if ((entry.action === "update_singleton" || entry.action === "update") && entry.after) {
        data = { ...data, ...entry.after };
      }
    }
    return { ...b, data };
  }

  return body;
}

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
            <td class="before">${escHtml(JSON.stringify(d.before))}</td>
            <td class="after">${escHtml(JSON.stringify(d.after))}</td>
          </tr>`).join("")}
        </tbody>
      </table>`
    : p.after
      ? `<pre style="margin-top:1rem;font-size:.8rem;overflow:auto;background:#f3f1ec;padding:1rem;border-radius:4px">${escHtml(JSON.stringify(p.after, null, 2))}</pre>`
      : "";

  const jumpUrl = `${previewBaseUrl}${previewPageForCollection(p.collection)}?pb_focus=${encodeURIComponent(p.preview_token)}`;

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

function buildReviewPage(focusToken: string, allPreviews: StoredPreview[]): string {
  const found = allPreviews.length > 0;
  const hasMany = allPreviews.length > 1;

  const cards = found
    ? allPreviews.map((p) => renderEntryCard(p, p.preview_token === focusToken, PREVIEW_WEBSITE_URL)).join("")
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
    a.btn{display:inline-flex}
  </style>
</head>
<body>
  <div style="display:flex;align-items:baseline;gap:1rem;margin-bottom:1.5rem;flex-wrap:wrap">
    <h1>Vorschau überprüfen</h1>
    <a href="${escHtml(PREVIEW_WEBSITE_URL)}" class="btn btn-preview" target="_blank" style="font-size:.8rem;padding:.35rem .9rem">Live-Vorschau ↗</a>
  </div>
  ${bulkBar}
  ${cards}
  <script>
    async function act(url, method, statusId, okMsg) {
      const el = document.getElementById(statusId);
      const r = await fetch(url, { method });
      if (el) {
        el.style.display = 'block';
        el.className = 'status ' + (r.ok ? 'ok' : 'err');
        el.textContent = r.ok ? okMsg : 'Fehler (' + r.status + ')';
      }
    }

    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-confirm],button[data-discard],#confirm-all,#discard-all');
      if (!btn || btn.disabled) return;
      btn.disabled = true;

      if (btn.id === 'confirm-all') {
        const tokens = ${JSON.stringify(allPreviews.map((p) => p.preview_token))};
        await Promise.all(tokens.map(t => fetch('/confirm/' + t, { method: 'POST' })));
        const el = document.getElementById('s-all');
        if (el) { el.style.display='block'; el.className='status ok'; el.textContent='✓ Alle Änderungen übernommen.'; }
      } else if (btn.id === 'discard-all') {
        const tokens = ${JSON.stringify(allPreviews.map((p) => p.preview_token))};
        await Promise.all(tokens.map(t => fetch('/preview/' + t, { method: 'DELETE' })));
        const el = document.getElementById('s-all');
        if (el) { el.style.display='block'; el.className='status ok'; el.textContent='✗ Alle Änderungen verworfen.'; }
      } else if (btn.dataset.confirm) {
        await act('/confirm/' + btn.dataset.confirm, 'POST', 's-' + btn.dataset.confirm, '✓ Übernommen und gespeichert.');
      } else if (btn.dataset.discard) {
        await act('/preview/' + btn.dataset.discard, 'DELETE', 's-' + btn.dataset.discard, '✗ Verworfen.');
      }
    });
  </script>
</body>
</html>`;
}

// ── Preview banner injection ──────────────────────────────────────────────────
//
// The banner is injected by the MCP proxy into every HTML page it serves.
// The website code has zero knowledge of this banner.
//
// Highlighting uses a position:fixed floating bar (not position:absolute) so it
// works even when the annotated element has overflow:hidden (events cards, faq).
//
// Navigation guard: Astro ViewTransitions re-executes body scripts on every
// navigation. window.__pbLoaded ensures full init runs only once; astro:page-load
// re-queries DOM refs and re-applies highlights after each swap.

function buildBannerInjection(mcpUrl: string): string {
  const mcp = JSON.stringify(mcpUrl);
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
  var BRD={create:'#16a34a',update:'#d97706',update_singleton:'#2563eb',delete:'#dc2626'};

  /* ---- DOM refs ---- */
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

  /* ---- Floating action bar ---- */
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

  /* ---- Direct text-marking ----
   * Find any text on the page that matches a changed field value and wrap it
   * with a <span class="pb-mark"> that has a visible coloured border via CSS.
   * Works for ANY page structure — no need to find "containers" or rely on
   * specific HTML tags. Completely independent of the website implementation.
   */

  // Strip markdown bold and pick the longest contiguous chunk that's likely
  // to appear in the rendered HTML as a single text node.
  // NOTE: all regex backslashes are doubled because this entire script lives
  // inside a TS template literal — single \\ → literal \\ in the served JS.
  function snippets(raw){
    if(typeof raw!=='string')return [];
    var clean=raw.replace(/\\*\\*(.+?)\\*\\*/g,'$1').trim();
    if(!clean)return [];
    var out=[];
    // First paragraph only — multi-line text becomes <p>…</p><p>…</p> in HTML
    var paras=clean.split(/\\n\\n+/);
    var first=(paras[0]||'').trim();
    if(first.length>=4)out.push(first.length>180?first.slice(0,180):first);
    // Plain single-line full string
    if(!clean.includes('\\n')&&clean.length>=4&&clean.length<=180&&out.indexOf(clean)===-1)out.push(clean);
    return out;
  }

  // Only return strings from fields that ACTUALLY CHANGED (from diff).
  // Numeric changes (e.g. price) are excluded — the template formats them
  // (e.g. price 100 → "€100.00") so a raw value search won't find them.
  function changedCandidates(p){
    var cands=[];
    var diff=p.diff||[];
    var action=p.action;
    if(diff.length>0){
      diff.forEach(function(d){
        // Preview DOM shows AFTER values (proxy applied them)
        if(typeof d.after==='string')snippets(d.after).forEach(function(s){cands.push(s);});
        // Before value may still appear for non-applied contexts
        if(typeof d.before==='string'&&d.before!==d.after)snippets(d.before).forEach(function(s){cands.push(s);});
      });
    } else {
      // No diff array — fall back to field values based on action type
      var after=p.after||{};
      var before=p.before||{};
      if(action==='delete'){
        Object.values(before).forEach(function(v){if(typeof v==='string')snippets(v).forEach(function(s){cands.push(s);});});
      } else {
        Object.values(after).forEach(function(v){if(typeof v==='string')snippets(v).forEach(function(s){cands.push(s);});});
      }
    }
    var seen={};
    return cands.filter(function(v){
      if(seen[v])return false;seen[v]=true;
      return v&&v.length>=4
        &&!/^https?:\\/\\//.test(v)
        &&!/^\\d{4}-\\d{2}-\\d{2}/.test(v);
    }).sort(function(a,b){return b.length-a.length;});
  }

  // Unchanged identifying fields used as positional anchor when no changed text
  // can be found (e.g. only numeric fields changed). Marked with .pb-anchor —
  // a dashed outline that signals "this item has a change" without implying the
  // text itself changed.
  function anchorCandidates(p){
    var after=p.after||{};var before=p.before||{};
    var cands=[];
    ['name','title','bezeichnung','question','first_name','last_name'].forEach(function(k){
      var v=String(after[k]||before[k]||'');
      if(v.length>=4)cands.push(v);
    });
    Object.keys(after).forEach(function(k){
      var v=after[k];
      if(typeof v==='string'&&v===before[k]&&v.length>=4&&cands.indexOf(v)===-1)cands.push(v);
    });
    return cands.slice(0,3);
  }

  // True if this text node is a candidate for marking.
  function isMarkableNode(n){
    if(!n.parentElement)return false;
    var p=n.parentElement;
    if(p.closest('#pb-root')||p.closest('#pb-float'))return false;
    if(p.closest('.pb-mark')||p.closest('.pb-anchor'))return false;
    var tag=p.tagName;
    if(tag==='SCRIPT'||tag==='STYLE'||tag==='NOSCRIPT'||tag==='TEMPLATE')return false;
    return true;
  }

  // Walk the DOM looking for the first text node containing searchText.
  // Wrap the matching substring in a styled span and return it.
  // isAnchor=true uses .pb-anchor (dashed outline, no bg) to signal the item
  // has a change without implying the anchor text itself changed.
  function markTextInDom(searchText,token,action,isAnchor){
    if(!searchText||searchText.length<3)return null;
    var tw=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null);
    var node;
    while((node=tw.nextNode())){
      if(!node.nodeValue)continue;
      if(!isMarkableNode(node))continue;
      var idx=node.nodeValue.indexOf(searchText);
      if(idx===-1)continue;
      var parent=node.parentNode;
      if(!parent)continue;

      var before=node.nodeValue.slice(0,idx);
      var matched=node.nodeValue.slice(idx,idx+searchText.length);
      var after=node.nodeValue.slice(idx+searchText.length);

      var span=document.createElement('span');
      span.className=isAnchor?'pb-anchor':'pb-mark';
      span.setAttribute('data-pb-token',token);
      span.setAttribute('data-pb-action',action);
      if(isAnchor)span.setAttribute('data-pb-anchor','1');
      span.textContent=matched;

      var frag=document.createDocumentFragment();
      if(before)frag.appendChild(document.createTextNode(before));
      frag.appendChild(span);
      if(after)frag.appendChild(document.createTextNode(after));

      parent.replaceChild(frag,node);
      return span;
    }
    return null;
  }

  /* ---- Clear / Apply marks ---- */
  function clearHighlights(){
    document.querySelectorAll('.pb-mark,.pb-anchor').forEach(function(span){
      var p=span.parentNode;if(!p)return;
      p.replaceChild(document.createTextNode(span.textContent||''),span);
      p.normalize();
    });
  }

  function applyHighlights(){
    clearHighlights();
    hlIndex=-1;
    if(!previews.length){hideFloat();return;}
    var totalMarked=0;
    previews.forEach(function(p){
      // Don't try to mark elements that live on a different page.
      if(p.preview_page&&p.preview_page!==location.pathname)return;

      // Pass 1: mark only actually-changed text (from diff string fields)
      var texts=changedCandidates(p);
      var hitsThisPreview=0;
      var maxHits=3;
      for(var i=0;i<texts.length&&hitsThisPreview<maxHits;i++){
        if(markTextInDom(texts[i],p.preview_token,p.action,false)){hitsThisPreview++;totalMarked++;}
      }
      // Pass 2: if no changed text found (e.g. only numeric fields changed),
      // use an anchor mark on the item's name so the user can still locate it.
      if(hitsThisPreview===0){
        var anchors=anchorCandidates(p);
        for(var j=0;j<anchors.length;j++){
          if(markTextInDom(anchors[j],p.preview_token,p.action,true)){totalMarked++;break;}
        }
        if(hitsThisPreview===0){
          console.warn('[preview-banner] no text matched for',p.collection,p.id||'',{tried:texts,anchors:anchors});
        }
      }
    });
    console.info('[preview-banner]',previews.length,'preview(s),',totalMarked,'text node(s) marked');
    if(hlBound)return;
    hlBound=true;
    document.addEventListener('mouseover',function(e){
      var el=e.target&&e.target.closest&&(e.target.closest('.pb-mark')||e.target.closest('.pb-anchor'));
      if(el)showFloat(el,el.dataset.pbToken,el.dataset.pbAction);
    });
    document.addEventListener('mouseout',function(e){
      var rt=e.relatedTarget;
      if(rt&&rt.closest&&((rt.closest('.pb-mark')||rt.closest('.pb-anchor'))||(pbFloat&&(rt===pbFloat||pbFloat.contains(rt)))))return;
      hideFloat();
    });
    if(pbFloat)pbFloat.addEventListener('mouseout',function(e){
      var rt=e.relatedTarget;
      if(rt&&(rt.closest&&(rt.closest('.pb-mark')||rt.closest('.pb-anchor'))||pbFloat.contains(rt)))return;
      hideFloat();
    });
  }

  // Group marks by preview_token — multiple marks per preview should count as one
  // navigation stop. Includes both .pb-mark (changed text) and .pb-anchor (locator).
  function markedTokens(){
    var seen={},order=[];
    document.querySelectorAll('.pb-mark,.pb-anchor').forEach(function(s){
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

  /* ---- Bottom banner ---- */
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
        var onThisPage=!p.preview_page||p.preview_page===location.pathname;
        var jumpLink=!onThisPage
          ?'<a href="'+escH(p.preview_page)+'?pb_focus='+escH(p.preview_token)+'" style="padding:3px 10px;background:#2563eb;color:#fff;border-radius:3px;font-size:12px;font-weight:600;text-decoration:none;white-space:nowrap;display:inline-block">↗ Zur Seite</a>'
          :'';
        return'<div style="display:flex;align-items:center;gap:10px;padding:9px 20px;border-bottom:1px solid #fef3c7;font-size:13px;flex-wrap:wrap">'
          +badge(p)+'<span style="font-weight:600;color:#1a1816;white-space:nowrap">'+escH(p.collection)+(p.id!=null?' #'+escH(String(p.id)):'')+'</span>'
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

  /* ---- Jump-to-element from review page ---- */
  // The review page links to the preview with ?pb_focus=<token>. On load we read
  // that param, find the element that was highlighted for that token, and scroll to it.
  // Runs only once per page load (pbFocusDone flag) so repeat load() calls don't re-scroll.
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
    render(); // update nav counter to show correct position
  }

  async function load(){
    try{var r=await fetch(MCP+'/previews');previews=r.ok?await r.json():[];}catch(e){previews=[];}
    render();applyHighlights();focusFromURL();
  }

  /* ---- Init & navigation ---- */
  getDom();
  load();

  // Re-query DOM refs after each Astro ViewTransitions swap and reload data.
  // hlBound stays true across navigations — the delegated listeners on document
  // persist and still work after the body swap.
  document.addEventListener('astro:page-load',function(){
    bound=false;
    pbFocusDone=false;
    getDom();
    load();
  });
})();
</script>`;
}

function injectBanner(html: string, mcpUrl: string): string {
  const injection = buildBannerInjection(mcpUrl);
  const idx = html.lastIndexOf("</body>");
  if (idx === -1) return html + injection;
  return html.slice(0, idx) + injection + html.slice(idx);
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  // Introspection
  {
    name: "list_collections",
    description:
      "List all user-facing collections in the Directus instance. Shows collection name, singleton status, icon, and note. Call this first to understand the available data model.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_collection_fields",
    description:
      "Get all fields for a specific collection, including field type, whether it is required, and UI options. Use this to understand what data a collection holds before reading or writing.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name (e.g. 'menu_items')" },
      },
      required: ["collection"],
    },
  },
  {
    name: "get_schema",
    description:
      "Get the full schema: all collections, all fields, and all relations in one call. Useful for a complete picture of the data model.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },

  // Read
  {
    name: "read_items",
    description:
      "Read multiple items from a collection. Supports field selection, Directus filter objects, sorting, pagination, and full-text search.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name" },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Fields to include in the response. Omit for all fields.",
        },
        filter: {
          type: "object",
          description: "Directus filter object, e.g. { \"available\": { \"_eq\": true } }",
        },
        sort: {
          type: "array",
          items: { type: "string" },
          description: "Sort fields. Prefix with '-' for descending, e.g. [\"-price\"]",
        },
        limit: { type: "number", description: "Maximum number of items to return" },
        offset: { type: "number", description: "Number of items to skip (for pagination)" },
        search: { type: "string", description: "Full-text search string" },
      },
      required: ["collection"],
    },
  },
  {
    name: "read_item",
    description:
      "Read a single item by primary key. If you only know a human-readable field (e.g. dish name), use read_items with a filter instead.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name" },
        id: { description: ITEM_PK_DESCRIPTION },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Fields to include in the response",
        },
      },
      required: ["collection", "id"],
    },
  },
  {
    name: "read_singleton",
    description:
      "Read the data of a singleton collection (a collection with exactly one record, e.g. 'site_settings', 'hero', 'about'). Use list_collections to identify which collections are singletons.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Singleton collection name" },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Fields to include in the response",
        },
      },
      required: ["collection"],
    },
  },

  // Write (all write tools always stage a preview — nothing is written until the user confirms via the review link)
  {
    name: "confirm_preview",
    description:
      "Apply a staged change to Directus. Call this only after the user has explicitly confirmed they want to apply the change. Pass the preview_token from the staging tool response. Returns a success message when the change has been written.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "The preview_token returned by create_item, update_item, update_items, update_singleton, or delete_item." },
      },
      required: ["token"],
    },
  },
  {
    name: "discard_preview",
    description:
      "Discard a staged change without writing anything. Call this when the user wants to cancel the pending change. Pass the preview_token from the staging tool response.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "The preview_token returned by the staging tool." },
      },
      required: ["token"],
    },
  },
  {
    name: "list_previews",
    description:
      "List all currently staged (unconfirmed) changes. Use this to show the user what is pending before a bulk confirm or discard.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "confirm_all_previews",
    description:
      "Confirm and apply every staged change at once. Call this only after the user has explicitly approved applying all pending changes.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "discard_all_previews",
    description:
      "Discard every staged change without writing anything. Nothing is written to Directus.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },

  {
    name: "create_item",
    description:
      "Stage a new item for creation. If you need to create multiple items, call this tool for each one before presenting anything to the user. Nothing is written until confirmed.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name" },
        data: {
          type: "object",
          description: "Item data as key-value pairs matching the collection's fields",
        },
      },
      required: ["collection", "data"],
    },
  },
  {
    name: "update_item",
    description:
      "Stage an update to an existing item. If you need to update multiple items, call this tool for each one before presenting anything to the user. Nothing is written until confirmed.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name" },
        id: { description: ITEM_PK_DESCRIPTION },
        data: {
          type: "object",
          description: "Fields to update as key-value pairs (partial update)",
        },
      },
      required: ["collection", "id", "data"],
    },
  },
  {
    name: "update_items",
    description:
      "Stage a bulk update for multiple items in a collection. Returns a preview_token for in-chat confirmation and a preview_url for visual inspection. Nothing is written until confirm_preview is called. Use this instead of calling update_item in a loop.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name" },
        ids: {
          type: "array",
          items: {},
          description: `List of primary keys to update. ${ITEM_PK_DESCRIPTION}`,
        },
        data: {
          type: "object",
          description: "Fields to set on all matched items (partial update)",
        },
      },
      required: ["collection", "ids", "data"],
    },
  },
  {
    name: "update_singleton",
    description:
      "Stage an update to a singleton collection (e.g. 'site_settings', 'hero', 'about'). Returns a before/after diff, a preview_token for in-chat confirmation, and a preview_url for visual inspection. Nothing is written until confirm_preview is called.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Singleton collection name" },
        data: {
          type: "object",
          description: "Fields to update as key-value pairs",
        },
      },
      required: ["collection", "data"],
    },
  },
  {
    name: "delete_item",
    description:
      "Stage a deletion. If you need to delete multiple items, call this tool for each one before presenting anything to the user. Nothing is deleted until confirmed.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name" },
        id: { description: ITEM_PK_DESCRIPTION },
      },
      required: ["collection", "id"],
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

// ── MCP Server factory ────────────────────────────────────────────────────────

function makeServer(client: DirectusClient): Server {
  const server = new Server(
    { name: "directus-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      switch (name) {
        // ── Introspection ────────────────────────────────────────────────────

        case "list_collections":
          return ok(await client.listCollections());

        case "get_collection_fields": {
          const { collection } = args as { collection: string };
          return ok(await client.getCollectionFields(collection));
        }

        case "get_schema":
          return ok(await client.getSchema());

        // ── Read ─────────────────────────────────────────────────────────────

        case "read_items": {
          const { collection, fields, filter, sort, limit, offset, search } = args as {
            collection: string;
            fields?: string[];
            filter?: Record<string, unknown>;
            sort?: string[];
            limit?: number;
            offset?: number;
            search?: string;
          };
          return ok(await client.readItems(collection, { fields, filter, sort, limit, offset, search }));
        }

        case "read_item": {
          const { collection, id, fields } = args as {
            collection: string;
            id: string | number;
            fields?: string[];
          };
          return ok(await client.readItem(collection, id, fields));
        }

        case "read_singleton": {
          const { collection, fields } = args as { collection: string; fields?: string[] };
          return ok(await client.readSingleton(collection, fields));
        }

        // ── Write ────────────────────────────────────────────────────────────

        case "create_item": {
          const { collection, data } = args as {
            collection: string;
            data: Record<string, unknown>;
          };
          const entry: PreviewEntry = { action: "create", collection, after: data, data };
          const token = storePreview(entry);
          return text(buildPreviewResponse(token, entry));
        }

        case "update_item": {
          const { collection, id, data } = args as {
            collection: string;
            id: string | number;
            data: Record<string, unknown>;
          };
          const res = await client.readItem(collection, id) as { data: Record<string, unknown> };
          const before = res.data;
          const after = { ...before, ...data };
          const entry: PreviewEntry = {
            action: "update", collection, id,
            before, after, diff: computeDiff(before, data), data,
          };
          const token = storePreview(entry);
          return text(buildPreviewResponse(token, entry));
        }

        case "update_items": {
          const { collection, data } = args as {
            collection: string;
            data: Record<string, unknown>;
          };
          const rawIds = (args as { ids: unknown }).ids;
          const ids: (string | number)[] = Array.isArray(rawIds)
            ? rawIds as (string | number)[]
            : typeof rawIds === "string"
              ? rawIds.split(",").map((s) => s.trim()).filter(Boolean)
              : typeof rawIds === "number"
                ? [rawIds]
                : [];
          const entry: PreviewEntry = {
            action: "update", collection, after: data, data,
            before: Object.fromEntries(ids.map((id) => [id, {}])),
          };
          const token = storePreview(entry);
          return text(buildPreviewResponse(token, entry));
        }

        case "update_singleton": {
          const { collection, data } = args as {
            collection: string;
            data: Record<string, unknown>;
          };
          const res = await client.readSingleton(collection) as { data: Record<string, unknown> };
          const before = res.data;
          const after = { ...before, ...data };
          const entry: PreviewEntry = {
            action: "update_singleton", collection,
            before, after, diff: computeDiff(before, data), data,
          };
          const token = storePreview(entry);
          return text(buildPreviewResponse(token, entry));
        }

        case "delete_item": {
          const { collection, id } = args as {
            collection: string;
            id: string | number;
          };
          const res = await client.readItem(collection, id) as { data: Record<string, unknown> };
          const entry: PreviewEntry = {
            action: "delete", collection, id, before: res.data,
          };
          const token = storePreview(entry);
          return text(buildPreviewResponse(token, entry));
        }

        case "confirm_preview": {
          const { token } = args as { token: string };
          const stored = previewStore.get(token);
          if (!stored) return err("Preview not found — it may have already been confirmed, discarded, or expired.");
          const { entry } = stored;
          clearTimeout(stored.timer);
          previewStore.delete(token);
          switch (entry.action) {
            case "create":           await client.createItem(entry.collection, entry.data!); break;
            case "update":           await client.updateItem(entry.collection, entry.id!, entry.data!); break;
            case "update_singleton": await client.updateSingleton(entry.collection, entry.data!); break;
            case "delete":           await client.deleteItem(entry.collection, entry.id!); break;
          }
          return text(`✓ Done. ${entry.action} on ${entry.collection}${entry.id != null ? ` #${entry.id}` : ""} has been written to Directus.`);
        }

        case "discard_preview": {
          const { token } = args as { token: string };
          const stored = previewStore.get(token);
          if (!stored) return err("Preview not found — it may have already been confirmed, discarded, or expired.");
          clearTimeout(stored.timer);
          previewStore.delete(token);
          return text(`✗ Discarded. Nothing was written to Directus.`);
        }

        case "list_previews": {
          if (previewStore.size === 0) return text("No staged changes.");
          const lines = Array.from(previewStore.entries()).map(([token, { entry }]) => {
            const diff = entry.diff?.map((d) => `${d.field}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`).join(", ") ?? "";
            return `- [${entry.action}] ${entry.collection}${entry.id != null ? ` #${entry.id}` : ""}${diff ? `  (${diff})` : ""}  token: ${token}`;
          });
          return text(`Staged changes (${previewStore.size}):\n${lines.join("\n")}`);
        }

        case "confirm_all_previews": {
          const entries = Array.from(previewStore.entries());
          if (!entries.length) return text("No staged changes to confirm.");
          for (const [token, { entry, timer }] of entries) {
            clearTimeout(timer);
            previewStore.delete(token);
            switch (entry.action) {
              case "create":           await client.createItem(entry.collection, entry.data!); break;
              case "update":           await client.updateItem(entry.collection, entry.id!, entry.data!); break;
              case "update_singleton": await client.updateSingleton(entry.collection, entry.data!); break;
              case "delete":           await client.deleteItem(entry.collection, entry.id!); break;
            }
          }
          return text(`✓ All ${entries.length} change(s) confirmed and written to Directus.`);
        }

        case "discard_all_previews": {
          const count = previewStore.size;
          if (!count) return text("No staged changes to discard.");
          for (const { timer } of previewStore.values()) clearTimeout(timer);
          previewStore.clear();
          return text(`✗ All ${count} staged change(s) discarded. Nothing was written to Directus.`);
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

// ── HTTP server ───────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3001);
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, mcp-session-id",
};

const httpServer = http.createServer();

httpServer.on("request", (req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS).end();
      return;
    }

    // ── MCP endpoint ──────────────────────────────────────────────────────────
    if (path === "/mcp") {
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", resolve);
        req.on("error", reject);
      });
      const body = chunks.length
        ? (JSON.parse(Buffer.concat(chunks).toString()) as unknown)
        : undefined;

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = makeServer(makeClient(req));
      res.on("close", () => transport.close().catch(() => {}));
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    // ── GET /previews ─────────────────────────────────────────────────────────
    if (method === "GET" && path === "/previews") {
      const entries = Array.from(previewStore.entries()).map(([token, { entry }]) => ({
        ...entry,
        preview_token: token,
        preview_page: previewPageForCollection(entry.collection),
      }));
      res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
        .end(JSON.stringify(entries));
      return;
    }

    // ── GET /preview/:token ───────────────────────────────────────────────────
    if (method === "GET" && path.startsWith("/preview/")) {
      const token = path.slice("/preview/".length);
      const stored = previewStore.get(token);
      if (!stored) {
        res.writeHead(404, { "Content-Type": "application/json", ...CORS_HEADERS })
          .end(JSON.stringify({ error: "Preview not found or expired" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
        .end(JSON.stringify({ ...stored.entry, preview_token: token }));
      return;
    }

    // ── POST /confirm/:token ──────────────────────────────────────────────────
    if (method === "POST" && path.startsWith("/confirm/")) {
      const token = path.slice("/confirm/".length);
      const stored = previewStore.get(token);
      if (!stored) {
        res.writeHead(404, { "Content-Type": "application/json", ...CORS_HEADERS })
          .end(JSON.stringify({ error: "Preview not found or expired" }));
        return;
      }

      const { entry } = stored;
      clearTimeout(stored.timer);
      previewStore.delete(token);

      const confirmClient = makeClient(req);
      switch (entry.action) {
        case "create":
          await confirmClient.createItem(entry.collection, entry.data!);
          break;
        case "update":
          await confirmClient.updateItem(entry.collection, entry.id!, entry.data!);
          break;
        case "update_singleton":
          await confirmClient.updateSingleton(entry.collection, entry.data!);
          break;
        case "delete":
          await confirmClient.deleteItem(entry.collection, entry.id!);
          break;
      }

      res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
        .end(JSON.stringify({ success: true, action: entry.action, collection: entry.collection }));
      return;
    }

    // ── DELETE /preview/:token ────────────────────────────────────────────────
    if (method === "DELETE" && path.startsWith("/preview/")) {
      const token = path.slice("/preview/".length);
      const stored = previewStore.get(token);
      if (stored) {
        clearTimeout(stored.timer);
        previewStore.delete(token);
      }
      res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
        .end(JSON.stringify({ success: true }));
      return;
    }

    // ── GET /review/:token ────────────────────────────────────────────────────
    if (method === "GET" && path.startsWith("/review/")) {
      const token = path.slice("/review/".length);
      const allPreviews = Array.from(previewStore.entries()).map(([t, { entry }]) => ({
        ...entry,
        preview_token: t,
      }));
      const html = buildReviewPage(token, allPreviews);
      res.writeHead(previewStore.has(token) ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" })
        .end(html);
      return;
    }

    // ── /directus-proxy/* ─────────────────────────────────────────────────────
    if (path.startsWith("/directus-proxy")) {
      const directusPath = path.slice("/directus-proxy".length) || "/";
      const directusUrl = `${DIRECTUS_UPSTREAM}${directusPath}${url.search || ""}`;

      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", resolve);
        req.on("error", reject);
      });
      const reqBody = chunks.length ? Buffer.concat(chunks) : undefined;

      const forwardHeaders: Record<string, string> = {};
      const auth = req.headers["authorization"];
      if (auth) forwardHeaders["Authorization"] = Array.isArray(auth) ? auth[0]! : auth;
      const ct = req.headers["content-type"];
      if (ct) forwardHeaders["Content-Type"] = Array.isArray(ct) ? ct[0]! : ct;

      const upstream = await fetch(directusUrl, {
        method,
        headers: forwardHeaders,
        body: reqBody?.length ? reqBody : undefined,
      });

      // Intercept GET /items/:collection and apply staged previews
      const itemsMatch = /^\/items\/([^/]+)(?:\/[^/]+)?$/.exec(directusPath);
      if (method === "GET" && itemsMatch && upstream.ok) {
        const collection = itemsMatch[1]!;
        const body = await upstream.json() as unknown;
        const modified = applyPreviewsToResponse(body, collection);
        res.writeHead(upstream.status, { "Content-Type": "application/json", ...CORS_HEADERS })
          .end(JSON.stringify(modified));
        return;
      }

      // Pass everything else through unchanged
      const resContentType = upstream.headers.get("content-type") ?? "application/octet-stream";
      const resBody = Buffer.from(await upstream.arrayBuffer());
      const cacheControl = upstream.headers.get("cache-control");
      const extraHeaders: Record<string, string> = { "Content-Type": resContentType, ...CORS_HEADERS };
      if (cacheControl) extraHeaders["Cache-Control"] = cacheControl;
      res.writeHead(upstream.status, extraHeaders).end(resBody);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "Not found" }));
  })().catch((e: unknown) => {
    process.stderr.write(`Request error: ${e instanceof Error ? e.message : String(e)}\n`);
    if (!res.headersSent) res.writeHead(500).end();
  });
});

httpServer.listen(PORT, () => {
  process.stderr.write(`directus-mcp listening on http://0.0.0.0:${PORT}/mcp\n`);
});

// ── Preview proxy server ──────────────────────────────────────────────────────
// Proxies the Astro website-preview instance and injects the banner into HTML.
// This keeps all preview UI logic out of the website codebase.

const previewProxyServer = http.createServer();

previewProxyServer.on("request", (req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://localhost:${PREVIEW_PROXY_PORT}`);
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS).end();
      return;
    }

    const targetUrl = `${PREVIEW_WEBSITE_INTERNAL_URL}${url.pathname}${url.search || ""}`;

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", resolve);
      req.on("error", reject);
    });
    const reqBody = chunks.length ? Buffer.concat(chunks) : undefined;

    const forwardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (["host", "connection", "transfer-encoding"].includes(key.toLowerCase())) continue;
      forwardHeaders[key] = Array.isArray(value) ? value[0]! : (value ?? "");
    }

    const upstream = await fetch(targetUrl, {
      method,
      headers: forwardHeaders,
      body: reqBody?.length ? reqBody : undefined,
    });

    const contentType = upstream.headers.get("content-type") ?? "";

    if (method === "GET" && contentType.includes("text/html") && upstream.ok) {
      const html = injectBanner(await upstream.text(), MCP_PUBLIC_URL);
      res.writeHead(upstream.status, { "Content-Type": "text/html; charset=utf-8" }).end(html);
      return;
    }

    const resBody = Buffer.from(await upstream.arrayBuffer());
    const outHeaders: Record<string, string> = { "Content-Type": contentType };
    const cacheControl = upstream.headers.get("cache-control");
    if (cacheControl) outHeaders["Cache-Control"] = cacheControl;
    res.writeHead(upstream.status, outHeaders).end(resBody);
  })().catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`Preview proxy error: ${msg}\n`);
    if (!res.headersSent) res.writeHead(502).end(`Preview proxy error: ${msg}`);
  });
});

previewProxyServer.listen(PREVIEW_PROXY_PORT, () => {
  process.stderr.write(`preview-proxy listening on http://0.0.0.0:${PREVIEW_PROXY_PORT}/\n`);
});
