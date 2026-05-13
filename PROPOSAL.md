# Project KI-gestützte Headless-CMS-Integration mit Preview- und Freigabe-Workflows

## Team

- Stefan Czepl
- Fabian Eberhardt

## Projekt-Metadaten

- **Projekt-Fokus:** MCP-Server für AI-gestützte CMS-Interaktion mit Preview- und Freigabe-Workflows
- **Referenzsystem:** Beliebige Directus-Instanzen (Headless CMS)
- **Technologie-Stack:** MCP Server (Node.js/TypeScript), LangChain, Ollama (Lokales LLM), Cursor & Claude (Entwicklung)

---

## 1. Ziel des Projekts

### High-Level Goal

Entwicklung eines MCP-Servers, der es einem LLM ermöglicht, jede beliebige Directus-Instanz eigenständig zu explorieren und zu bearbeiten. Mit diesem kann die KI das Datenmodell (Collections, Felder, Bilder) bei Bedarf selbst abfragen, den Kontext prüfen und daraufhin präzise Bearbeitungsschritte vorschlagen.

Das System kombiniert die Flexibilität eines generischen CMS-Wrappers mit der Sicherheit eines **Human-in-the-Loop-Workflows**: KI-generierte Vorschläge werden erst nach einem visuellen Diff-Check und manueller Freigabe persistiert.

### Validierung des Ziels

- **Dynamische Exploration:** Das LLM kann über ein Tool (z.B. `get_schema`) unbekannte Headless CMS-Strukturen zur Laufzeit verstehen.
- **Schema-Agnostische Bearbeitung:** Erfolgreiche Modifikation von Inhalten in unterschiedlichen Directus-Setups ohne Code-Anpassung am MCP-Server.
- **End-to-End Validierung:** Eine eigens generierte Beispiel-Website dient als Referenz, um die Korrektheit der KI-gesteuerten Inhaltsänderungen visuell und funktional zu bestätigen.

---

## 2. Systemarchitektur & Workflow

### Hauptkomponenten

1.  **Generic Directus MCP Server:** Stellt Tools zur Verfügung, die sowohl Metadaten (Schema-Infos) als auch Content-Daten (CRUD) via Directus-API abrufbar machen.
2.  **AI Agent (Ollama):** Ein lokales LLM, das die Tools nutzt, um das Schema zu verstehen, den Kontext zu validieren und Inhaltsänderungen zu formulieren.
3.  **Preview & Diff Service:** Berechnet die Differenz zwischen dem aktuellen Stand im CMS und dem KI-Vorschlag zur Validierung durch den Nutzer.
4.  **Validation Website:** Eine dedizierte Frontend-Anwendung, die die manipulierten Daten live anzeigt, um die Wirksamkeit des Systems zu belegen.

### KI-gestützter Entwicklungs-Workflow

- **Agentic Development:** Nutzung von **Cursor & Claude** für das Rapid Prototyping des MCP-Servers und der generischen API-Logik.
- **Local-AI Execution:** Einsatz von **Ollama**, um die Content-Manipulation lokal und datenschutzkonform durchzuführen.

---

## 3. KI-Einsatz im Projektverlauf

| Phase             | Fokus der KI-Unterstützung                                              | Tools           |
| :---------------- | :---------------------------------------------------------------------- | :-------------- |
| **Konzeption**    | Design der Introspection-Tools (`inspect_collection`, `list_fields`).   | Claude          |
| **Entwicklung**   | Implementierung der dynamischen API-Abstraktion und des Tool-Handlings. | Cursor, Claude  |
| **Content Logic** | Optimierung der Strategie, wie das LLM das Schema effizient abfragt.   | Ollama          |
| **Validation**    | Generierung der Beispiel-Inhalte und Struktur für die Test-Website.     | Cursor / Claude |
| **Dokumentation** | Erstellung technischer Guides und des AI Decision Logs.                 | Claude          |

---

## 4. Projektplan (Meilensteine)

### Milestone 1: Directus MCP Wrapper

Implementierung universeller Tools für Lese- und Schreibzugriffe, welche die Kommunikation mit dem CMS ermöglichen.

### Milestone 2: Preview & Approval Logic

Bau der Pipeline, die KI-Vorschläge puffert und für den User als Diff aufbereitet, bevor sie per API-Call finalisiert werden.

### Milestone 3: Integration & Local LLM Test

Anbindung von Ollama. Validierung des Workflows: LLM erkennt Schema -> LLM schlägt Änderung vor -> User bestätigt -> CMS wird aktualisiert.

### Milestone 4: Website-Generierung & Validierung

Erstellung einer funktionalen Beispiel-Website auf Basis des Directus-Backends. Die KI optimiert die Inhalte (Texte, Bild-Referenzen, SEO-Daten) über den MCP-Server; das Ergebnis wird visuell auf der Website validiert, um zu bestätigen, dass der generische Ansatz mit realen UI-Komponenten funktioniert.

---

## 5. Aufwandsschätzung & Zeitplan

Der geschätzte Gesamtaufwand beläuft sich auf ca. **24–28 Personenstunden**, verteilt auf beide Teammitglieder. Durch den Einsatz von KI-Agents (Cursor) wird die reine Implementierungszeit verkürzt; Validierung und Prompt-Iteration sind entsprechend höher gewichtet.

| Meilenstein             | Aktivität                                                                                                    | Geschätzter Aufwand (h) |
|:------------------------| :----------------------------------------------------------------------------------------------------------- |:------------------------|
| **M1: CMS Wrapper**     | Research Directus Metadata API, Prompting der Discovery-Tools, MCP-Infrastruktur Setup.                      | 10h                     |
| **M2: Preview Logic**   | Entwicklung des State-Managements für "Pending Changes", Implementierung der Diff-Ansicht (JSON/Text).       | 6h                      |
| **M3: Integration**     | Anbindung Ollama, Optimierung der System-Prompts für Schema-Exploration, End-to-End Workflow Tests.          | 6h                      |
| **M4: Validation Site** | Setup des Frontends (z.B. Next.js), Content-Generierung durch KI, finale Qualitätssicherung & Dokumentation. | 6h                      |
| **Gesamt**              |                                                                                                              | **28h**                 |
