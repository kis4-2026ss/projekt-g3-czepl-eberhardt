# Project Proposal: Generic AI-to-Directus MCP Bridge

## Team

- Stefan Czepl
- Fabian Eberhardt

## Projekt-Metadaten

- **Projekt-Fokus:** Generischer, introspektiver MCP-Server für Directus
- **Referenzsystem:** Beliebige Directus-Instanzen (Headless CMS)
- **Technologie-Stack:** MCP Server (Node.js/TypeScript), Ollama (Lokales LLM), Cursor & Claude (Entwicklung)

---

## 1. Ziel des Projekts (Goal)

### High-Level Goal

Entwicklung eines universellen MCP-Servers, der es einem LLM ermöglicht, jede beliebige Directus-Instanz eigenständig zu explorieren und zu bearbeiten. Anstatt ein festes Schema vorauszusetzen, stellt der Server **Introspection-Tools** bereit. Mit diesen kann die KI das Datenmodell (Collections, Felder, Relationen) bei Bedarf selbst abfragen, den Kontext prüfen und daraufhin präzise Bearbeitungsschritte vorschlagen.

Das System kombiniert die Flexibilität eines generischen CMS-Wrappers mit der Sicherheit eines **Human-in-the-Loop-Workflows**: KI-generierte Vorschläge werden erst nach einem visuellen Diff-Check und manueller Freigabe persistiert.

### Validierung des Ziels

- **Dynamische Exploration:** Das LLM kann über ein Tool (z.B. `get_schema`) unbekannte CMS-Strukturen zur Laufzeit verstehen.
- **Schema-Agnostische Bearbeitung:** Erfolgreiche Modifikation von Inhalten in unterschiedlichen Directus-Setups ohne Code-Anpassung am MCP-Server.
- **End-to-End Validierung:** Eine eigens generierte Beispiel-Website dient als Referenz, um die Korrektheit der KI-gesteuerten Inhaltsänderungen visuell und funktional zu bestätigen.

---

## 2. Systemarchitektur & Workflow

### Hauptkomponenten

1.  **Generic Directus MCP Server:** Stellt Tools zur Verfügung, die sowohl Metadaten (Schema-Infos) als auch Content-Daten (CRUD) via Directus-API abrufbar machen.
2.  **Schema Exploration Tool:** Ein spezielles Tool innerhalb des MCP-Servers, das dem LLM die Architektur der verbundenen Instanz offenlegt.
3.  **AI Agent (Ollama):** Ein lokales LLM, das die Tools nutzt, um das Schema zu "lernen", den Kontext zu validieren und Inhaltsänderungen zu formulieren.
4.  **Preview & Diff Service:** Berechnet die Differenz zwischen dem aktuellen Stand im CMS und dem KI-Vorschlag zur Validierung durch den Nutzer.
5.  **Validation Website:** Eine dedizierte Frontend-Anwendung, die die manipulierten Daten live anzeigt, um die Wirksamkeit des Systems zu belegen.

### KI-gestützter Entwicklungs-Workflow

- **Agentic Development:** Nutzung von **Cursor & Claude** für das Rapid Prototyping des MCP-Servers und der generischen API-Logik.
- **Local-AI Execution:** Einsatz von **Ollama**, um die Content-Manipulation lokal und datenschutzkonform durchzuführen.

---

## 3. KI-Einsatz im Projektverlauf

| Phase             | Fokus der KI-Unterstützung                                              | Tools           |
| :---------------- | :---------------------------------------------------------------------- | :-------------- |
| **Konzeption**    | Design der Introspection-Tools (`inspect_collection`, `list_fields`).   | Claude          |
| **Entwicklung**   | Implementierung der dynamischen API-Abstraktion und des Tool-Handlings. | Cursor          |
| **Content Logic** | Optimierung der Strategie, wie das LLM das Schema effizient abfragt.    | Ollama          |
| **Validation**    | Generierung der Beispiel-Inhalte und Struktur für die Test-Website.     | Cursor / Claude |
| **Dokumentation** | Erstellung technischer Guides und des AI Decision Logs.                 | Claude          |

---

## 4. Projektplan (Meilensteine)

### Milestone 1: Introspection Engine

Entwicklung der Tools, die es dem LLM ermöglichen, das Schema einer Directus-Instanz abzufragen (`get_collections`, `get_fields`). Fokus auf der Bereitstellung von ausreichend Kontext für die KI.

### Milestone 2: Generische CRUD-Tools

Implementierung universeller Tools für Lese- und Schreibzugriffe, die dynamisch auf die durch die Introspection gefundenen Felder reagieren.

### Milestone 3: Preview & Approval Logic

Bau der Pipeline, die KI-Vorschläge puffert und für den User als Diff aufbereitet, bevor sie per API-Call finalisiert werden.

### Milestone 4: Integration & Local LLM Test

Anbindung von Ollama. Validierung des Workflows: LLM erkennt Schema -> LLM schlägt Änderung vor -> User bestätigt -> CMS wird aktualisiert.

### Milestone 5: Website-Generierung & Validierung

Erstellung einer funktionalen Beispiel-Website, die auf dem Directus-Backend basiert. In diesem Schritt wird die KI beauftragt, die Website-Inhalte (z.B. Texte, Bilder-Referenzen, SEO-Daten) über den MCP-Server zu optimieren. Das finale Ergebnis wird auf der Website validiert, um sicherzustellen, dass der generische Ansatz für reale UI-Komponenten funktioniert.

## 5. Aufwandsschätzung & Zeitplan

Der geschätzte Gesamtaufwand beläuft sich auf ca. **24 bis 28 Personenstunden (h)**, verteilt auf die beiden Teammitglieder. Durch den Einsatz von KI-Agents (Cursor) wird die reine Implementierungszeit verkürzt, während die Zeit für Validierung und Prompt-Iteration höher gewichtet ist.

| Meilenstein             | Aktivität                                                                                                    | Geschätzter Aufwand (h) |
| :---------------------- | :----------------------------------------------------------------------------------------------------------- | :---------------------- |
| **M1: Introspection**   | Research Directus Metadata API, Prompting der Discovery-Tools, MCP-Infrastruktur Setup.                      | 4h                      |
| **M2: CRUD-Tools**      | Generische Tool-Definitionen in TypeScript, Error-Handling, dynamische Payload-Validierung.                  | 6h                      |
| **M3: Preview Logic**   | Entwicklung des State-Managements für "Pending Changes", Implementierung der Diff-Ansicht (JSON/Text).       | 6h                      |
| **M4: Integration**     | Anbindung Ollama, Optimierung der System-Prompts für Schema-Exploration, End-to-End Workflow Tests.          | 6h                      |
| **M5: Validation Site** | Setup des Frontends (z.B. Next.js), Content-Generierung durch KI, finale Qualitätssicherung & Dokumentation. | 6h                      |
| **Gesamt**              |                                                                                                              | **28h**                 |
