# Code reviewen. Gemeinsam mit deinem Agenten.

![Änderungen ansehen, direkt am Code kommentieren, gemeinsam klären und prüfen](media/pair-review-flow.svg)

**Änderungen ansehen, Fragen klären und den Code gemeinsam verbessern — direkt in VS Code.** Dein Agent bekommt gesendetes Feedback automatisch und antwortet im selben Kommentarverlauf.

Die Bilder sind nachgestellte Beispiele der Bedienung, keine Aufnahme einer geprüften Live-Sitzung.

## Einmal verbinden

Öffne dein Projekt in VS Code und wähle **Pair Review: Mit Claude verbinden**. Starte eine neue Claude-Code-Unterhaltung oder setze die letzte fort. Die verbundene Unterhaltung läuft im integrierten Terminal. Eine unabhängig gestartete Claude-Sitzung wird nicht automatisch verbunden. [Installation und Verbindung](INSTALL.md)

## Direkt im Code kommentieren

Öffne in der Seitenleiste die Ansicht **Local** und wähle **Review local changes**. Die Review-Seite zeigt deine noch nicht committeten Änderungen und neuen Dateien. Klicke auf eine Zeilennummer, schreibe zum Beispiel „Nutze exponentielles Backoff.“ und wähle **Implement**. Claude bekommt deinen Kommentar zusammen mit Datei, Zeilen und Codekontext. Ein ungesendeter Entwurf bleibt ein Entwurf.

| Schaltfläche | Was du möchtest |
| --- | --- |
| **Ask Claude** | Eine Frage stellen oder den Code besprechen. |
| **Implement** | Eine konkrete Änderung umsetzen lassen. |

## Antwort prüfen

Der Status zeigt, ob dein Auftrag wartet, empfangen wurde, bearbeitet wird oder zur Prüfung bereitsteht. Claudes Antwort erscheint im ursprünglichen Thread auf der Review-Seite. Mehrzeiliger Code steht in einem eigenen farbigen Codeblock. **Open in editor** öffnet die Datei im Editor.

Du kannst weiterfragen, eine weitere Änderung anfordern oder den Thread erledigen. **Eine Antwort von Claude erledigt den Thread nicht automatisch.**

Mit **Resolve** erledigst du einen Thread, mit **Reopen** machst du ihn wieder aktiv. Der Verlauf bleibt gespeichert.

## Fragt Claude ständig nach Kommentaren?

**Das Sprachmodell tut das nicht.** Ein kleiner Helfer auf deinem Rechner wartet im Hintergrund auf gesendetes Feedback. Sobald ein Kommentar vorliegt, gibt er dessen Inhalt an Claude weiter. Dafür sind keine laufenden Modellanfragen nötig. Falls gerade ein Werkzeug läuft, darf es zunächst fertig werden.

<details>
<summary>Technische Details und Quellen</summary>

Der Standardweg kombiniert Claude-Code-Hooks mit MCP-Werkzeugen. Das Modell führt keine wiederkehrende Abfrage aus; ein lokaler Hilfsprozess verwendet **Long Polling**.

Pair Review speichert jeden Auftrag zuerst mit unveränderlicher Ereignis-ID, Datei, Zeilen und Codekontext im lokalen Workspace-Speicher von VS Code. Erst nach erfolgreichem Speichern werden wartende Komponenten benachrichtigt. [Speicherung](../src/store.ts) · [Übergebener Kontext](../src/eventPrompt.ts)

Der Hook-Helfer liest ausstehende Aufträge über `GET /pending` und hält anschließend eine lokale Anfrage über `GET /events?after=<sequence>` offen. Ein neues gespeichertes Ereignis beantwortet diese Anfrage sofort. Ohne Arbeit läuft eine leere Anfrage nach spätestens 20 Sekunden aus; der Helfer prüft den aktuellen Arbeitsstand und wartet erneut. **Die 20 Sekunden sind kein Zustellintervall.** Der Helfer liefert den Auftrag über einen `asyncRewake`-Hook an Claude Code. Claude erhält ihn an einem sicheren Verarbeitungspunkt; laufende Werkzeugaufrufe werden nicht abgebrochen. [Hook-Helfer](../src/hookWaiter.ts) · [Long Polling](../src/bridge.ts)

Eine lokale Zustellhistorie pro Claude-Sitzung verhindert, dass jeder neue `Stop`- oder Werkzeug-Hook denselben noch unbestätigten Kommentar wieder ankündigt. Die Nachricht beginnt mit Datei, Modus und kurzem Feedback-Auszug; gemeinsame Anweisungen stehen pro Nachrichtenpaket nur einmal darin. Die Bestätigung im Review-Speicher ändert sich dadurch nicht. `SessionStart` umgeht die Historie bewusst und stellt den neuesten unerledigten Auftrag jedes offenen Threads wieder bereit, auch beim Fortsetzen derselben Unterhaltung. Frühere Aufträge bleiben als Verlauf erhalten, werden nach einem Folgekommentar aber nicht als neue Arbeit zugestellt.

Claude bestätigt mit `acknowledge_review`, meldet den Arbeitsbeginn mit `set_review_working` und antwortet mit `reply_to_review`. „Verbunden“ allein bestätigt keinen einzelnen Auftrag. Der MCP-Helfer prüft zusätzlich alle 15 Sekunden die lokale Verbindung. Auch diese Prüfung ist kein Modellaufruf. [MCP-Werkzeuge und Verbindungsprüfung](../src/channel.ts)

Die Hook-Konfiguration aktiviert den Wartehelfer bei `SessionStart`, `UserPromptSubmit`, `PostToolUse` und `Stop`. Eine Sperre begrenzt ihn auf einen aktiven Helfer pro Workspace. Nach bis zu 24 Stunden endet ein Helfer; erneut verbinden oder Claude eine Eingabe senden aktiviert den Warteweg wieder. Bereits gesendete Aufträge bleiben gespeichert. Nach Unterbrechungen kann eine Zustellung wiederholt werden. Ereignis-IDs unterstützen die Zuordnung, garantieren aber keine exakt einmaligen Codeänderungen. [Start und Konfiguration](../src/setup.ts) · [Wiederanlauf und Sperre](../src/hookWaiter.ts)

Die lokale Übergabe verwendet eine authentifizierte Verbindung auf `127.0.0.1`. Claude nutzt für die eigentliche Modellverarbeitung weiterhin seinen konfigurierten Anbieter. Erzeugte Integrationsdateien liegen außerhalb des Projekt-Repositories im Workspace-Speicher. Dafür werden keine Projektdateien wie `.claude/settings.json` oder `.mcp.json` umgeschrieben. [Verbindungsprüfung](../src/connection.ts) · [Lokaler Server](../src/bridge.ts) · [Integrationsdateien](../src/setup.ts)

**Warum Hooks der Standard sind:** Sie passen zum aktuellen Terminal- und Gateway-Ablauf. Der alternative Channels-Modus leitet Benachrichtigungen über MCP an Claude weiter und lässt sich ausdrücklich auswählen. Er ist derzeit eine Research Preview mit besonderen Anforderungen an Anmeldung und Organisationsfreigabe. Laut Claude-Dokumentation werden Bedrock, Vertex AI und Microsoft Foundry dafür nicht unterstützt. Die Kompatibilität mit einem beliebigen Gateway ist damit nicht zugesichert. Channels bleibt eine optionale Alternative. [Offizielle Claude-Code-Dokumentation zu Channels](https://code.claude.com/docs/en/channels) · [Transportwahl](../src/setup.ts) · [Channel-Benachrichtigungen](../src/channel.ts)

</details>

<details>
<summary>Zur Grafik und zum Prüfstand</summary>

Die [SVG-Grafik](media/pair-review-flow.svg) zeigt den gemeinsamen Review-Zyklus mit nachgestellten Kommentaren und echten JavaScript-Ausschnitten. Neutrale helle Flächen, klare Typografie und dezente Akzente halten den Fokus auf dem Code und den Entscheidungen im Review. Die Grafik enthält keine externen Abhängigkeiten.

Die daraus gerenderte [PNG-Version](media/pair-review-flow.png) wird im README und Installationspaket verwendet, weil VS Codes Paketprüfung SVG-Bilder im README ablehnt.

Stand: Version 0.4.4. Die Darstellung erklärt die implementierte Bedienung und ist kein Nachweis einer bereits vollständig geprüften Live-Sitzung. Den aktuellen Prüfstand dokumentiert [REVIEW.md](REVIEW.md).

</details>
