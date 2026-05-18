# Architecture Decision Log

Wichtige Entscheidungen, die während der Entwicklung des Projekts getroffen wurden.
Jeder Eintrag dokumentiert Kontext, Entscheidung und Konsequenzen.

---

## ADR-1: Google Gemini statt lokales Ollama-Modell

**Status:** Entschieden

**Kontext:**
Im ursprünglichen Proposal war ein lokales LLM via Ollama vorgesehen, um Datenschutz und Unabhängigkeit von externen Cloud-Diensten zu gewährleisten. In ersten Tests mit verschiedenen lokalen Modellen (Llama 3.x, Mistral, Qwen) zeigte sich jedoch, dass die Tool-Calling-Qualität für unseren Multi-Tool-Workflow nicht ausreichte:

- Function-Call-Format wurde inkonsistent erzeugt (mal als JSON, mal als Pseudo-Code)
- Mehrstufige Tool-Ketten (z.B. erst `read_items` filtern, dann `update_item` mit der ID) wurden häufig abgebrochen
- Die Modelle ignorierten oder halluzinierten Feldnamen

**Entscheidung:**
Umstieg auf Google Gemini (`gemini-3.1-flash-lite`) als LLM-Backend. Gemini bietet robustes, standardkonformes Tool-Calling und beherrscht Multi-Step-Workflows zuverlässig.

**Konsequenzen:**
- ✅ Tool-Calling funktioniert zuverlässig, End-to-End-Flow ist demonstrierbar
- ✅ Streaming-Responses werden unterstützt (`astream_events`)
- ❌ Abhängigkeit von externem Cloud-Dienst und API-Key
- ❌ Datenschutz-Argument aus dem Proposal entfällt
- ℹ️ MCP-Anbindung bleibt LLM-agnostisch — ein Wechsel zurück zu Ollama (oder einem anderen Modell) ist jederzeit ohne Änderungen am MCP-Server möglich

---

## ADR-2: In-Memory Preview-Store statt persistente Datenbank

**Status:** Entschieden

**Kontext:**
Staged Changes müssen zwischen "stage" (Tool-Aufruf) und "confirm/discard" (Browser-Aktion) zwischengespeichert werden. Optionen: PostgreSQL-Tabelle, Redis, lokale SQLite-Datei oder ein In-Memory `Map`.

**Entscheidung:**
JavaScript `Map<token, PreviewEntry>` mit 30-Minuten TTL (`mcp-server/src/index.ts:77-85`).

**Konsequenzen:**
- ✅ Keine zusätzliche Infrastruktur, kein DB-Schema zu pflegen
- ✅ Tokens sind randomUUIDs — keine Kollisionsgefahr
- ❌ Bei Restart des MCP-Servers gehen ungespeicherte Previews verloren
- ❌ Skaliert nicht auf mehrere Server-Instanzen
- ℹ️ Für den Demo-Use-Case und Single-User-Bedienung absolut ausreichend

---

## ADR-3: Banner-Injection statt eigene Preview-Komponente in der Astro-Website

**Status:** Entschieden

**Kontext:**
Auf der Preview-Seite muss visualisiert werden, welche Felder gerade gestaged sind (Hervorhebung im DOM, Floating-Action-Bar zum Confirm/Discard). Optionen: (a) Preview-spezifische Astro-Komponente, (b) Banner-Code in jede Seite einbinden, (c) Banner per HTTP-Response-Rewrite injizieren.

**Entscheidung:**
Variante (c): Der MCP-Server fungiert als Reverse-Proxy auf Port 4322 und injiziert vor jedem `</body>` einen `<script>`+`<style>`-Block (`mcp-server/src/index.ts:804-808`).

**Konsequenzen:**
- ✅ Die Astro-Website bleibt komplett CMS-/Preview-unwissend — sie kann ohne Änderungen produktiv ausgeliefert werden
- ✅ Banner-Code und Astro-Code entwickelt sich getrennt
- ✅ DOM-Marking basiert auf `data-cms-*`-Attributen, die ohnehin für andere Zwecke nützlich sind
- ❌ Bei kaputtem HTML (kein `</body>`) wird der Banner ans Ende gehängt — Fallback funktioniert
- ❌ Banner-Logik liegt im MCP-Server, nicht im Frontend — ungewohnter Ort für UI-Code

---

## ADR-4: Directus-Proxy-Layer im MCP-Server für die Preview-Site

**Status:** Entschieden

**Kontext:**
Die Preview-Site soll gestaged-Änderungen sichtbar machen, _bevor_ sie in Directus geschrieben wurden. Direkte Astro→Directus-Anfragen würden nur die echten (un-gestageden) Daten zurückgeben.

**Entscheidung:**
Der `website-preview`-Container nutzt als `DIRECTUS_URL` nicht das echte Directus, sondern den MCP-Server unter `http://mcp-server:3001/directus-proxy`. Der MCP-Server leitet alle `/items/:collection`-GETs an Directus weiter und merged die staged Changes via `applyPreviewsToResponse()` in die Response.

**Konsequenzen:**
- ✅ Astro-Code muss nichts über Previews wissen
- ✅ Sowohl Einzelitems, Listen, als auch Singletons werden korrekt überlagert
- ✅ Live-Site auf Port 4321 bleibt unbeeinflusst (geht direkt an Directus)
- ❌ Proxy-Layer ist eine zusätzliche Fehlerquelle (Netzwerk, JSON-Parsing)

---

## ADR-5: Server-Side Field-Validation statt Prompt-Engineering

**Status:** Entschieden

**Kontext:**
Frühere Versionen hatten das Problem, dass die KI nicht-existente Feldnamen erfinden konnte (z.B. `headline` statt `title`). Erste Lösung: System-Prompt-Regel "Rufe vor jedem Write `get_collection_fields` auf". Das hat zwei Probleme: (1) verbraucht zusätzliche Recursion-Steps und führt schnell zum Limit, (2) ist nicht zuverlässig — die KI hält sich nicht immer dran.

**Entscheidung:**
`validateFields()` im MCP-Server (`mcp-server/src/index.ts:1052-1064`) prüft bei jedem Write-Tool, ob alle Keys in `data` tatsächliche Felder der Collection sind. Bei unbekannten Feldern wird ein Fehler mit der Liste der gültigen Felder zurückgegeben — die KI kann den Fehler lesen und mit den richtigen Feldnamen erneut versuchen.

**Konsequenzen:**
- ✅ Robust: KI kann keine Geist-Felder mehr schreiben, egal wie schlecht der Prompt gestellt ist
- ✅ Selbstkorrigierend: Fehlermeldung enthält die Liste der gültigen Felder
- ✅ Recursion-effizient: kein zusätzlicher Tool-Call vor jedem Write
- ℹ️ Funktioniert als zweite Verteidigungslinie zusätzlich zum System-Prompt

---

## ADR-6: Astro statt Next.js für die Validation-Website

**Status:** Entschieden

**Kontext:**
Die Validation-Website muss CMS-Inhalte serverseitig rendern. Optionen: Next.js, Nuxt, Astro, SvelteKit, Remix.

**Entscheidung:**
Astro mit SSR-Mode.

**Konsequenzen:**
- ✅ Schlanker als Next.js — kein React-Runtime im Browser nötig, da die Seite statisches HTML ausliefert
- ✅ `data-cms-*`-Attribute werden direkt in Komponenten gesetzt, ohne Hydration-Komplikationen
- ✅ Schnelle Auslieferung, einfaches Mental-Model
- ❌ Kleinere Community als Next.js — bei exotischen Problemen weniger Stack-Overflow-Treffer

---

## ADR-7: LangGraph ReAct-Agent statt eigene Tool-Loop

**Status:** Entschieden

**Kontext:**
Der Agent muss: Tool-Aufrufe orchestrieren, Streaming-Responses liefern, Multi-Turn-Konversation halten und MCP-Tools dynamisch laden.

**Entscheidung:**
`create_react_agent` aus `langgraph.prebuilt` plus `MemorySaver` für Session-State (`agent/main.py:64-69`).

**Konsequenzen:**
- ✅ Streaming via `astream_events("v2")` funktioniert out-of-the-box
- ✅ Session-Persistenz über `thread_id` ohne eigenen Code
- ✅ MCP-Tools werden über `langchain_mcp_adapters` automatisch als LangChain-Tools registriert
- ❌ Abhängigkeit von der LangGraph-Library-Version (Pin auf `>=0.2,<1`)
- ℹ️ Recursion-Limit wurde manuell auf 100 erhöht für Bulk-Workflows

---

## ADR-8: Streamable-HTTP MCP-Transport statt Stdio

**Status:** Entschieden

**Kontext:**
MCP unterstützt zwei Transports: Stdio (für CLI-Clients wie Claude Desktop) und Streamable-HTTP (für Browser/HTTP-Clients). Da unsere Chat-UI im Browser läuft und der Agent ein HTTP-Service ist, muss der Transport HTTP-basiert sein.

**Entscheidung:**
Streamable-HTTP auf Port 3001 unter `/mcp`. Der MCP-Server bleibt aber zusätzlich Stdio-kompatibel (über `mcp-remote` aus dem Setup-Script), damit Claude Desktop ihn nutzen kann.

**Konsequenzen:**
- ✅ Agent-API kann den MCP-Server wie eine normale HTTP-Ressource konsumieren
- ✅ Mehrere parallele Clients möglich (Browser-Chat + Claude Desktop)
- ✅ Einfaches Debuggen mit curl/Postman gegen `/mcp`

---

## ADR-9: Single-File MCP-Server statt modulare Aufteilung

**Status:** Entschieden

**Kontext:**
`mcp-server/src/index.ts` ist mit ~1500 Zeilen relativ groß. Naheliegend wäre eine Aufteilung in mehrere Module (tools.ts, preview-store.ts, banner.ts, proxy.ts).

**Entscheidung:**
Bewusst in einer Datei belassen.

**Konsequenzen:**
- ✅ Für Code-Review und FH-Bewertung ist die gesamte Logik an einem Ort einsehbar
- ✅ Keine künstlichen Abhängigkeiten zwischen Modulen
- ✅ Banner-JS und Server-Code teilen sich Konstanten und Helper natürlich
- ❌ Bei weiterem Wachstum (> 2000 Zeilen) wäre Aufteilung sinnvoll
- ℹ️ Klare Section-Marker mit `// ── Name ──` strukturieren die Datei lesbar

---

## ADR-10: Idempotente Confirm/Discard-Endpoints (HTTP 200 statt 404)

**Status:** Entschieden

**Kontext:**
Wenn der User in der Review-Page auf "Übernehmen" klickt, die Seite refreshed oder den Button doppelklickt, ist der Token nach dem ersten Erfolg gelöscht. Ursprüngliches Verhalten: HTTP 404 mit "Preview not found". Das führte zu verwirrender UX.

**Entscheidung:**
`/confirm/:token` und `DELETE /preview/:token` geben HTTP 200 mit `{ alreadyApplied: true }` zurück, wenn der Token nicht (mehr) existiert. Verhalten ist idempotent.

**Konsequenzen:**
- ✅ Mehrfach-Klick und Browser-Reload führen zu kein "Fehler"-Banner
- ✅ Frontend-Code muss keine 404-Spezialfälle behandeln
- ℹ️ Echte Fehler (z.B. Directus down beim Schreiben) werden weiterhin als 500/Error gemeldet
