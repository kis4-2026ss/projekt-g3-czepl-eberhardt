# KI-gestützte Headless-CMS-Integration

**FH-Projekt KIS4** | Team: Stefan Czepl, Fabian Eberhardt

Ein generischer MCP-Server, der ein LLM in die Lage versetzt, beliebige Directus-Instanzen zu erkunden und zu bearbeiten — mit visuellem Preview-Mode und Human-in-the-Loop-Freigabe.

> **Verwandte Dokumente:**
> - [PROPOSAL.md](./PROPOSAL.md) — Projektvorschlag und Meilensteine
> - [ARCHITECTURE.md](./ARCHITECTURE.md) — Technische Architektur, Tool-Spec, Preview-Lifecycle
> - [DECISIONS.md](./DECISIONS.md) — Architecture Decision Log

---

## Was dieses Projekt macht

Über ein Chat-Interface kann ein User in natürlicher Sprache Inhalte eines Headless-CMS bearbeiten ("Ändere den Preis vom Schnitzel auf 12 €" / "Lösche alle abgelaufenen Events"). Die KI nutzt einen **MCP-Server**, der das Directus-Schema dynamisch erkundet und CRUD-Operationen ausführt. **Kein Schreibvorgang ist sofort live** — jede Änderung wird zuerst _gestaged_ und auf einer Vorschauseite visualisiert. Erst nach manueller Bestätigung durch den User wird die Änderung in das CMS geschrieben.

Das System ist **schema-agnostisch**: Der MCP-Server enthält keinen hartcodierten Bezug zu einer bestimmten Datenstruktur. Er funktioniert mit jeder Directus-Instanz, deren Schema die KI zur Laufzeit über `list_collections` und `get_collection_fields` erfragen kann.

---

## Architektur (Kurzfassung)

```
┌─────────────┐    HTTP     ┌────────────────┐   MCP    ┌──────────────┐   REST   ┌──────────┐
│  Browser    ├────────────►│   agent-api    ├─────────►│  mcp-server  ├─────────►│ Directus │
│  Chat-UI    │             │  (FastAPI +    │          │  (Node/TS)   │          │  (CMS)   │
│             │             │   LangGraph +  │          │              │          │          │
│             │             │   Gemini)      │          │  + Preview-  │          │          │
│             │             │                │          │    Store     │          │          │
└─────────────┘             └────────────────┘          └──────┬───────┘          └──────────┘
                                                               │
                                                               │ injiziert Banner +
                                                               │ proxied Directus
                                                               ▼
                                                       ┌──────────────┐
                                                       │ website-     │
                                                       │ preview      │
                                                       │ (Astro SSR)  │
                                                       └──────────────┘
```

Details siehe [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Tech-Stack

- **MCP-Server**: Node.js 22 + TypeScript, `@modelcontextprotocol/sdk`
- **Agent**: Python 3.12 + FastAPI + LangGraph + `langchain-mcp-adapters`
- **LLM**: Google Gemini (`gemini-3.1-flash-lite`) — Begründung für die Wahl statt Ollama siehe [DECISIONS.md → ADR-1](./DECISIONS.md)
- **CMS**: Directus 11.1.2 (PostgreSQL 16 + Redis)
- **Website**: Astro 4 mit SSR
- **Orchestrierung**: Docker Compose

---

## Quickstart

### Voraussetzungen
- Docker + Docker Compose
- Bash-Shell (für `docker-clean-start.sh`)
- Google API Key (https://aistudio.google.com) für Gemini

### Setup

```bash
# 1. Google API Key in agent/.env eintragen
cp agent/.env.example agent/.env
# Dann GOOGLE_API_KEY in agent/.env eintragen

# 2. Stack starten (baut Images, seedet Directus, startet alles)
./docker-clean-start.sh
```

Nach ~1 Minute sind alle Services verfügbar:

| URL | Beschreibung |
|---|---|
| http://localhost:8000 | **Chat-UI** (Hauptinterface) |
| http://localhost:4321 | Live-Website (echte Daten) |
| http://localhost:4322 | Preview-Website (mit Staged Changes + Banner) |
| http://localhost:8055 | Directus Admin (`admin@gmail.at` / `admin`) |
| http://localhost:3001/mcp | MCP-Endpunkt (für Claude Desktop o.ä.) |

### Optionen für `docker-clean-start.sh`

```bash
./docker-clean-start.sh             # Standard-Reset: DB + Uploads wipen, node_modules behalten
./docker-clean-start.sh --full      # Auch node_modules wipen (langsamer)
./docker-clean-start.sh --no-cache  # Volle no-cache Rebuilds der Docker-Images
```

---

## Demo-Flow

Schritt-für-Schritt-Beispiel des Human-in-the-Loop-Workflows:

1. **Öffne** http://localhost:8000
2. **Frage** im Chat: _"Welche Schnitzel haben wir auf der Karte?"_
   → Die KI nutzt `read_items` mit Filter und listet Treffer auf.
3. **Frage** weiter: _"Ändere den Preis vom Wiener Schnitzel auf 14,90 €"_
   → Die KI nutzt `update_item`. Antwort enthält:
   - Eine Preview-URL (http://localhost:3001/review/&lt;token&gt;)
   - Eine Live-Vorschau-URL (http://localhost:4322)
4. **Öffne** http://localhost:4322
   → Die Preview-Website zeigt das Schnitzel auf der Speisekarte gelb hervorgehoben mit dem neuen Preis. Eine Action-Bar unten zeigt "1 Änderung anstehend" mit Buttons _Übernehmen_ / _Verwerfen_.
5. **Öffne** http://localhost:3001/review/&lt;token&gt;
   → Diff-Tabelle: Feld `price` | Vorher `9.80` | Nachher `14.90`.
6. **Klick** "Übernehmen"
   → MCP-Server schreibt die Änderung in Directus. In der Live-Website (http://localhost:4321) ist der neue Preis nun sichtbar.

Für Bulk-Demos: _"Erhöhe alle Hauptspeisen-Preise um 1 €"_ → die KI nutzt `update_items` und stagt _eine_ Bulk-Operation.

---

## Services & Container

| Service (compose) | Container | Ports | Rolle |
|---|---|---|---|
| `database` | `directus-db` | – | PostgreSQL für Directus |
| `cache` | `directus-cache` | – | Redis (Cache derzeit deaktiviert) |
| `directus` | `directus` | 8055 | Headless CMS |
| `website` | `adlerwirt-web` | 4321 | Live-Astro-Site, fetched echtes Directus |
| `website-preview` | `agent-web-preview` | – | Preview-Astro-Site, fetched durch MCP-Proxy |
| `mcp-server` | `directus-mcp-server` | 3001, 4322 | MCP-Endpoint (3001) + Preview-Reverse-Proxy (4322) |
| `agent-api` | `agent-api` | 8000 | FastAPI Chat-Server (LangGraph + Gemini) |
| `seed` | `directus-seed` | – | Einmaliger Job: legt Beispieldaten an |

---

## MCP-Tools (Überblick)

Der MCP-Server stellt 15 Tools bereit. Vollständige Spezifikation siehe [ARCHITECTURE.md](./ARCHITECTURE.md).

**Introspection**
- `list_collections`, `get_collection_fields`, `get_schema`

**Read (direkt)**
- `read_items`, `read_item`, `read_singleton`

**Write (staged — nichts wird sofort geschrieben)**
- `create_item`, `update_item`, `update_items`, `update_singleton`, `delete_item`

**Preview-Management**
- `list_previews`, `confirm_preview`, `discard_preview`, `confirm_all_previews`, `discard_all_previews`

Schutzmaßnahme: `validateFields()` im MCP-Server prüft bei jedem Write, dass alle gelieferten Felder tatsächlich existieren — die KI kann keine erfundenen Felder schreiben.

---

## Claude Desktop anbinden (optional)

Der MCP-Server lässt sich zusätzlich aus Claude Desktop heraus nutzen.

In `claude_desktop_config.json` (Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "directus": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3001/mcp"]
    }
  }
}
```

Danach Claude Desktop neu starten.

---

## Projektstruktur

```
.
├── agent/                  # Python FastAPI + LangGraph (Chat-Server)
│   ├── main.py
│   ├── static/index.html   # Chat-UI
│   ├── requirements.txt
│   └── Dockerfile
├── mcp-server/             # Node.js + TypeScript MCP-Server
│   ├── src/
│   │   ├── index.ts        # Tools, Preview-Store, Banner, Proxy (~1500 LOC)
│   │   └── directus.ts     # REST-Client
│   ├── package.json
│   └── Dockerfile
├── website/                # Astro Validation-Website
│   ├── src/pages/          # 6 Seiten (index, speisekarte, events, …)
│   ├── src/components/     # Mit data-cms-* Attributen
│   └── src/lib/directus.ts # CMS-Fetcher
├── seed/                   # Einmaliger Beispieldaten-Loader
│   ├── seed.py
│   ├── schema.json
│   └── images/
├── docker-compose.yml
├── docker-clean-start.sh   # One-Shot-Reset + Restart + Seed
├── PROPOSAL.md
├── ARCHITECTURE.md
├── DECISIONS.md
└── README.md  ← du bist hier
```

---

## Bekannte Einschränkungen

Dieses Projekt ist eine **lokale Demo**, kein Produktivsystem. Bewusste Vereinfachungen:

- Keine Authentifizierung auf den HTTP-Endpoints des MCP-Servers
- In-Memory Preview-Store (kein persistenter Audit-Trail; TTL 30 min)
- Hartcodierte Directus-Credentials in `docker-compose.yml`
- Kein File-/Image-Upload-Tool (nur Verweise auf bestehende Asset-IDs möglich)
- Keine automatisierten Tests

Volle Auflistung und Begründungen siehe [DECISIONS.md](./DECISIONS.md).
