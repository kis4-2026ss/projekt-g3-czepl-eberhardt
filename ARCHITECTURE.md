# Architecture: Generic AI-to-Directus MCP Bridge

## Overview

This document describes the technical architecture of a generic, introspective MCP (Model Context Protocol) Server that bridges any AI agent (LLM) to a Directus headless CMS instance. The system enables schema-agnostic content exploration and manipulation with a human-in-the-loop approval workflow.

---

## System Components

```
┌──────────────────────────────────────────────────────────────────┐
│                          AI Agent Layer                          │
│                                                                  │
│   ┌──────────────┐          ┌───────────────────────────────┐    │
│   │  Claude /    │          │    Browser Chat UI            │    │
│   │  Cursor IDE  │          │    (agent-api, FastAPI)       │    │
│   │  (dev tool)  │          │    LangGraph + Gemini         │    │
│   └──────┬───────┘          └───────────────┬───────────────┘    │
│          │  MCP Protocol                    │  MCP Protocol      │
└──────────┼──────────────────────────────────┼───────────────────-┘
           │                                  │
           ▼                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Generic Directus MCP Server                  │
│                      (Node.js / TypeScript)                      │
│                                                                  │
│  ┌─────────────────────────┐  ┌──────────────────────────────┐   │
│  │   Introspection Tools   │  │       CRUD Tools             │   │
│  │  ─────────────────────  │  │  ────────────────────────    │   │
│  │  • list_collections     │  │  • read_items                │   │
│  │  • get_collection_fields│  │  • read_item                 │   │
│  │  • get_schema           │  │  • read_singleton            │   │
│  └─────────────────────────┘  │  • create_item               │   │
│                                │  • update_item               │   │
│  ┌─────────────────────────┐  │  • update_items              │   │
│  │   Preview / Approval    │  │  • update_singleton          │   │
│  │  ─────────────────────  │  │  • delete_item               │   │
│  │  • preview store (TTL)  │  └──────────────────────────────┘   │
│  │  • diff computation     │                                      │
│  │  • review page          │  ┌──────────────────────────────┐   │
│  │  • confirm_preview      │  │  Preview Proxy (port 4322)   │   │
│  │  • discard_preview      │  │  • banner injection          │   │
│  │  • list_previews        │  │  • directus-proxy            │   │
│  │  • confirm_all_previews │  │  • applies staged changes    │   │
│  │  • discard_all_previews │  └──────────────────────────────┘   │
│  └─────────────────────────┘                                      │
│                                                                  │
│                    DirectusClient (directus.ts)                  │
│            token auth · schema fetch · generic fetch             │
└──────────────────────────────┬───────────────────────────────────┘
                               │ REST API (HTTP)
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Directus Instance (port 8055)                │
│                                                                  │
│   ┌───────────────┐   ┌─────────────────┐   ┌────────────────┐  │
│   │  PostgreSQL   │   │      Redis      │   │  Directus API  │  │
│   │   (port 5432) │   │   (cache)       │   │   /items/      │  │
│   │               │◄──┤                 │◄──┤   /schema/     │  │
│   └───────────────┘   └─────────────────┘   │   /auth/       │  │
│                                             └────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Services & Ports

| Service | Container | Port | Purpose |
|---------|-----------|------|---------|
| `database` | `directus-db` | 5432 | PostgreSQL for Directus |
| `cache` | `directus-cache` | (intern) | Redis (cache disabled by default) |
| `directus` | `directus` | 8055 | Headless CMS |
| `website` | `adlerwirt-web` | 4321 | Astro live site (fetches from real Directus) |
| `website-preview` | `agent-web-preview` | (intern 4321) | Astro preview site (fetches via MCP proxy) |
| `mcp-server` | `directus-mcp-server` | 3001, 4322 | MCP server (3001) + preview-proxy (4322) |
| `agent-api` | `agent-api` | 8000 | FastAPI + LangGraph chat UI |
| `seed` | `directus-seed` | – | Einmaliger Job, schreibt Beispieldaten via REST |

---

## MCP Tool Specification

Alle Tools sind in `mcp-server/src/index.ts:813-1033` definiert. Sie gruppieren sich in drei Kategorien:

### Introspection — Schema-Erkundung

| Tool | Inputs | Output |
|------|--------|--------|
| `list_collections` | – | Array aller User-Collections (ohne Directus-Systemtabellen) |
| `get_collection_fields` | `collection` | Array von Feld-Definitionen (Name, Typ, Required-Flag) |
| `get_schema` | – | Vollständiges Schema: Collections + Fields + Relations |

### Read — Daten lesen (keine Staging-Logik, direkter Pass-Through)

| Tool | Inputs | Output |
|------|--------|--------|
| `read_items` | `collection`, optional: `fields`, `filter`, `sort`, `limit`, `offset`, `search` | Array von Items |
| `read_item` | `collection`, `id`, optional `fields` | Einzelnes Item |
| `read_singleton` | `collection`, optional `fields` | Singleton-Datensatz |

### Write — Staging-Tools (alle staged → kein direkter DB-Schreibzugriff)

| Tool | Inputs | Side Effect |
|------|--------|-------------|
| `create_item` | `collection`, `data` | Staged: neue Action `create`, Token zurück |
| `update_item` | `collection`, `id`, `data` | Staged: Action `update`, Diff berechnet |
| `update_items` | `collection`, `ids[]`, `data` | Staged: Action `update_bulk` |
| `update_singleton` | `collection`, `data` | Staged: Action `update_singleton`, Diff berechnet |
| `delete_item` | `collection`, `id` | Staged: Action `delete` |

Vor dem Staging prüft `validateFields()` (`mcp-server/src/index.ts:1052-1064`) gegen das echte Schema. Unbekannte Felder werden mit Fehler + Liste der gültigen Felder abgelehnt.

### Preview-Management

| Tool | Inputs | Effekt |
|------|--------|--------|
| `list_previews` | – | Listet alle offenen Staged Changes |
| `confirm_preview` | `token` | Wendet ein Preview auf Directus an, löscht den Token |
| `discard_preview` | `token` | Verwirft ein Preview ohne Schreibvorgang |
| `confirm_all_previews` | – | Wendet alle offenen Previews an |
| `discard_all_previews` | – | Verwirft alle offenen Previews |

---

## Preview Lifecycle

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│   KI ruft Write-Tool                                         │
│   (create_item / update_item / update_items /                │
│    update_singleton / delete_item)                           │
│                                                              │
└────────────────────────────────┬─────────────────────────────┘
                                 │
                                 ▼
                       ┌──────────────────┐
                       │     STAGED       │
                       │                  │
                       │  preview_token   │
                       │  + diff + entry  │
                       │  in In-Memory    │
                       │  Map (TTL 30min) │
                       └──┬────────────┬──┘
                          │            │
            ┌─────────────┘            └─────────────┐
            │                                        │
            ▼                                        ▼
   ┌─────────────────┐                      ┌─────────────────┐
   │  User klickt    │                      │  User klickt    │
   │  "Übernehmen"   │                      │  "Verwerfen"    │
   │  in Review-Page │                      │  in Review-Page │
   │  oder Banner    │                      │  oder Banner    │
   │  oder confirm_  │                      │  oder discard_  │
   │  preview-Tool   │                      │  preview-Tool   │
   └────────┬────────┘                      └────────┬────────┘
            │                                        │
            ▼                                        ▼
   ┌─────────────────┐                      ┌─────────────────┐
   │    APPLIED      │                      │    DISCARDED    │
   │                 │                      │                 │
   │ Token gelöscht, │                      │ Token gelöscht, │
   │ Directus-       │                      │ nichts          │
   │ Schreibvorgang  │                      │ geschrieben     │
   │ ausgeführt      │                      │                 │
   └─────────────────┘                      └─────────────────┘
```

**Speicherort:** In-Memory `Map<string, { entry: PreviewEntry; timer: Timeout }>` (`mcp-server/src/index.ts:77`)

**TTL:** 30 Minuten (`PREVIEW_TTL_MS`). Nach Ablauf wird der Eintrag automatisch entfernt.

**Token-Format:** RFC-4122 UUIDv4 via `crypto.randomUUID()`.

**Idempotenz:** Confirm/Discard auf bereits gelöschte Tokens geben HTTP 200 mit `alreadyApplied: true` zurück — vereinfacht das Frontend und macht Mehrfach-Klicks/Reloads unkritisch (siehe ADR-10).

---

## Live Preview System (Port 4322)

Die Preview-Site (`website-preview`-Container) zeigt die Website _so, wie sie nach dem Übernehmen aller offenen Changes aussehen würde_. Sie wird **nicht direkt** vom Browser erreicht, sondern über den MCP-Server geroutet:

```
                     ┌──────────────────┐
  Browser:           │  http://         │
  öffnet             │  localhost:4322  │
                     └────────┬─────────┘
                              │ HTTP
                              ▼
            ┌─────────────────────────────────────┐
            │   mcp-server  (Port 4322)           │
            │   "Preview Proxy"                   │
            │                                     │
            │   1. Forward request to             │
            │      http://website-preview:4321    │
            │   2. Receive HTML                   │
            │   3. Inject banner before </body>   │
            │   4. Return modified HTML           │
            └────────┬────────────────────────────┘
                     │ HTTP (internal Docker net)
                     ▼
            ┌─────────────────────────────────────┐
            │  website-preview  (Astro SSR)       │
            │                                     │
            │  fetches its CMS data from:         │
            │  http://mcp-server:3001/            │
            │       directus-proxy/items/...      │
            └────────┬────────────────────────────┘
                     │
                     ▼
            ┌─────────────────────────────────────┐
            │  mcp-server  (Port 3001)            │
            │  "/directus-proxy/*"                │
            │                                     │
            │  1. Forward to real Directus        │
            │  2. Receive JSON response           │
            │  3. applyPreviewsToResponse()       │
            │     merges staged changes into      │
            │     the items array / singleton     │
            │  4. Return merged JSON              │
            └────────┬────────────────────────────┘
                     │
                     ▼
                  Directus
```

### Banner Injection

`injectBanner()` (`mcp-server/src/index.ts:804-808`) sucht das letzte `</body>` in der HTML-Response und fügt davor einen `<script>`+`<style>`-Block ein. Das Banner:

- Lädt offene Previews via `GET /previews` aus dem MCP-Server
- Sucht im DOM Elemente mit `data-cms-collection`, `data-cms-field`, `data-cms-id` (siehe Astro-Komponenten in `website/src/components/`) und markiert sie farblich
- Zeigt eine schwebende Action-Bar mit "Übernehmen" / "Verwerfen" pro Token
- Zusätzlich gibt es eine Bottom-Bar mit der Liste aller offenen Changes und Navigationspfeilen

### Directus-Proxy

`/directus-proxy/*` auf Port 3001 ist ein transparenter HTTP-Reverse-Proxy zu Directus mit einer Sonder-Behandlung für `GET /items/:collection` und `GET /items/:collection/:id`. Hier wird `applyPreviewsToResponse()` aufgerufen, das die im Preview-Store gepufferten Änderungen in die Directus-Antwort einrechnet:

- `create`-Action → fügt ein neues Item mit `id: "__preview_new__"` hinzu
- `update`/`update_bulk`-Action → mergt die staged Felder in das passende Item
- `delete`-Action → entfernt das Item aus der Response
- `update_singleton`-Action → mergt die staged Felder in den Singleton-Datensatz

So sieht der Astro-Code im Preview-Container immer den "Was wäre wenn"-Zustand.

---

## Request Flow — End-to-End

Beispielablauf: User schreibt im Chat _"Ändere den Preis vom Schnitzel auf 12 €"_.

```
1.  Browser POSTs /chat to agent-api (port 8000) with the message.

2.  LangGraph ReAct-Agent (Gemini) decides to call MCP tool read_items
    on collection "menu_items" with filter { name: { _icontains: "Schnitzel" } }
    to find the item ID.

3.  agent-api forwards the tool call via MCP over HTTP to mcp-server:3001/mcp.

4.  mcp-server's DirectusClient does GET /items/menu_items?filter=... to
    the real Directus (port 8055). Returns the matching item with id=42.

5.  Agent receives the result, then calls update_item with collection="menu_items",
    id=42, data={ "price": 12 }.

6.  mcp-server validates the fields, fetches the current item, computes the diff,
    stores a PreviewEntry under a new UUID token, and returns a preview-response
    text including the review URL (http://localhost:3001/review/<token>)
    and preview URL (http://localhost:4322).

7.  Agent streams the response back to the browser:
    "Ich habe den Preis von 9,80 € auf 12 € geändert. Review: ..."

8.  User opens the review URL or visits localhost:4322:
    - Review page (3001) shows the diff in a table.
    - Preview page (4322) shows the menu with the new price highlighted in yellow.

9.  User clicks "Übernehmen" in either the review page or the floating banner.

10. The browser POSTs to mcp-server:3001/confirm/<token>.
    mcp-server reads the staged entry, calls DirectusClient.updateItem(),
    deletes the token, and returns 200 OK.

11. (Optional) User asks the agent "what's still pending?".
    Agent calls list_previews — which now returns empty.
    Agent answers correctly that no changes are pending.
```

---

## Security Assumptions

Dieses Projekt ist als **lokale Demo** konzipiert. Folgende Einschränkungen sind bewusst:

- **Keine Authentifizierung** auf den HTTP-Endpoints des MCP-Servers (`/mcp`, `/confirm`, `/preview`, `/review`, `/directus-proxy`, `/previews`)
- **CORS auf `*`** — jeder Origin darf den MCP-Server ansprechen
- **In-Memory Preview-Store** — kein persistenter Audit-Log
- **Hartcodierte Credentials** in `docker-compose.yml` für Directus-Admin (`admin@gmail.at` / `admin`) und der Service-Token (`adlerwirt-dev-token`)
- **API-Keys in `.env.example`** — die Datei ist via `.gitignore` (Zeile 5) vom Repo ausgeschlossen, der echte Key wird nicht eingecheckt

Für einen Produktionseinsatz wären zu ergänzen: Bearer-Token-Auth auf allen Endpoints, persistente Datenbank für den Preview-Store mit Audit-Trail, getrennte API-Tokens pro Client, Rate-Limiting.

---

## Key Files

| Datei | Zweck |
|-------|-------|
| `mcp-server/src/index.ts` | MCP-Server, Tools, Preview-Store, Review-Page, Banner-Injection, Preview-Proxy |
| `mcp-server/src/directus.ts` | Directus REST-Client (Auth, generische `request<T>()`-Methode) |
| `agent/main.py` | FastAPI + LangGraph + Gemini, MCP-Client-Setup |
| `agent/static/index.html` | Minimale Chat-UI (HTML + JS, SSE-Streaming) |
| `docker-compose.yml` | Orchestrierung aller 7 Services + Volumes |
| `website/src/lib/directus.ts` | Astro-seitiger Directus-Fetcher (geht via DIRECTUS_URL — entweder echt oder Proxy) |
| `website/src/pages/*.astro` | Astro-Seiten mit `data-cms-*`-Annotation für Banner-Marking |
| `seed/seed.py` | Einmaliger Daten-Seeder (legt Collections und Beispielinhalte an) |

Weitere Hintergründe zu Designentscheidungen siehe [DECISIONS.md](./DECISIONS.md).
