# Local Review

<img src="https://raw.githubusercontent.com/flucas96/local-review/main/resources/icon.png" alt="Local Review icon" width="80" height="80" />

### Review local code. Give Claude feedback where it belongs.

GitHub-style review conversations, directly in VS Code. Select a line in your local changes, ask a question or request a change, and send it straight to Claude Code in your terminal. Replies return to the same inline thread.

[Install the preview](INSTALL.md) · [Download a VSIX](https://github.com/flucas96/local-review/releases) · [Report an issue](https://github.com/flucas96/local-review/issues/new/choose)

[![Watch the Local Review demo](media/local-review-poster.jpg)](media/local-review-demo.mp4)

**Demo:** staged interface with simulated Claude responses, showing the optional side composer. The default input is now native inline comments. It is not a recording of a verified live integration.

## A review that becomes a conversation

Open a diff, leave feedback, and keep reviewing. Each submitted comment reaches your connected agent automatically—there is no separate review submission.

| Action | What Claude is asked to do |
| --- | --- |
| **Ask `/a`** | Explain a decision or discuss the code. |
| **Implement `/i`** | Make the requested change, then return it for your review. |
| **Summarize `/r`** | Condense the conversation and its remaining decisions. |

Native VS Code comments keep the conversation next to the code. Each Review list entry shows its filename, line and status. Status-only updates keep existing message controls in place. Claude can reply and report progress; **you decide when a thread is resolved**.

Use the **✓** on a thread or Review list entry to resolve it. Completed conversations disappear from the editor and list. The Review toolbar's **eye** shows them again; **Wieder öffnen** restores an active thread. Nothing is deleted.

If unfocused conversations blend into your editor, choose the **half-filled circle · Kommentarfenster hervorheben** in the Review toolbar, or run that command from the Command Palette. Activate it once per project; installation alone does not change the colors. It adds a distinct thread surface, darker reply field and neutral border for the current theme. **Standarddarstellung wiederherstellen** restores the previous colors. VS Code shares these colors with other native comments and Peek results in the same project; high-contrast themes retain their native colors.

For a narrower reading area, choose **Review → … → Zentrierte Ansicht**. This toggles VS Code's centered layout, narrowing the source and inline comments together; drag its side boundaries to adjust the width. Native comment width cannot be set separately. Side-by-side diffs and multiple editor groups may expand again with VS Code's default layout settings.

Write directly beside the changed code: click the gutter **+**, enter `/a`, `/i`, or `/r` followed by your feedback, then use the single **Senden** action. The prefix determines the mode when sending. Bare `/r` or `/R` summarizes an existing thread without extra text. Existing threads have a native reply field, so the conversation stays attached to its code.

The gutter **+** focuses its input directly; drafts opened by an extension command may need a click into the input because VS Code's stable API cannot focus that field.

Prefer a separate input? **Local Review: Feedback in Seitenansicht schreiben** opens a compact composer with live mode buttons, saved drafts and selection following. An empty draft follows new selections without moving focus; written drafts stay pinned and offer an explicit switch. Selected lines remain outlined when you click into the composer. Active text composition is preserved before slash switching, and bare `/r` on a new comment explains that it needs an existing conversation. Closing keeps drafts for **Local Review: Entwurf fortsetzen**. Native inline draft recovery remains managed by VS Code.

**Speak on macOS:** click the input, type `/a` or `/i`, then use your Mac's Microphone key or Dictation shortcut. Review the text and choose **Senden**. [Dictation guide →](DICTATION.md)

Code blocks appear in darker rounded cards with a compact file/language header and VS Code's syntax colors; missing fence languages inherit the review file's language for display. Choose the small **editor icon** in the reply header beside the author or beside the composer's code preview (hover for its label) to use the real editor. Replies with several code blocks offer a compact picker. A confirmed unique match opens the current project file, where hover, Cmd/Ctrl-click and F12 work through your installed language support. Proposed or ambiguous code opens as a clearly labeled, read-only code preview with limited project navigation. The chat and draft stay in place. Inline Markdown blocks remain display-only. Clearly recognized, standalone JavaScript/TypeScript imports and exported functions receive display-only code boxes even in older replies. This includes attached JSDoc and an isolated documented function header; missing bodies are never invented. Ambiguous text remains prose.

## Carry the conversation into your PR

Use the **An GitHub-PR übergeben** action in the Review toolbar. Local Review finds the current branch's open PR and prepares an editable preview of available summaries and unresolved questions. Select the content, inspect the exact PR and text, then explicitly publish it. Later handoffs update your managed review comment instead of adding a duplicate.

Edited or failed handoffs can be resumed after closing the preview during the same VS Code session. **Entwurf fortsetzen** keeps the original snapshot; **Neue Momentaufnahme** prepares current content. This recovery ends when VS Code reloads. Editing published text clearly marks it as unpublished again.

`/r` still summarizes a local conversation; it never publishes to GitHub. The first handoff uses a PR discussion comment with captured code locations, because local changes may not match the pushed PR's diff lines. Publishing requires the [GitHub CLI](https://cli.github.com/) installed and signed in. [PR handoff guide →](PR-HANDOFF.md)

## Start in a minute

Download a `.vsix` from [GitHub Releases](https://github.com/flucas96/local-review/releases), then choose **Extensions → … → Install from VSIX…** in VS Code. The extension is not published on the Marketplace yet.

Open a trusted local Git repository and run **Local Review: Mit Claude verbinden**:

| Choice | Result |
| --- | --- |
| **Unterhaltung auswählen** | Claude opens its session picker so you can resume the conversation that built the feature, with its history. |
| **Neue Unterhaltung** | Start a fresh conversation with review feedback enabled. |

If your chosen conversation is still running, use `/exit` there before resuming it. This preserves the saved conversation; connecting a running process in place is not supported by this release. For a separate terminal app, use **Review → … → Verbindungsbefehl kopieren**, choose existing or new, and paste the command at the shell prompt. It includes the project folder and the review settings. Keep the project's VS Code window open.

Open **Local Review: Änderungen reviewen**, then click the gutter **+** or select code and press **⌘⌥M** on macOS / **Ctrl+Alt+M** on Linux. Write `/a Why this approach?` or `/i Make this change…` and choose **Senden**. Continue directly in the thread's reply field. The current interface uses German labels.

Requires **VS Code 1.100+**, **Node.js 22+**, **Git**, and an installed, authenticated **Claude Code with `asyncRewake` support**. macOS is the primary target; Linux is unverified. Automatic connection is currently unavailable on Windows. [Installation and troubleshooting →](INSTALL.md)

## How the connection works

![Code review with an agent: inspect changes, comment, discuss or change, and verify](media/local-review-flow.png)

Send a comment and your connected Claude session receives it automatically. Claude's answer returns to the same conversation. The LLM does not repeatedly check for comments; a small local helper waits for saved feedback. An already running tool can finish before Claude handles the new request. [Visual walkthrough and optional technical details →](HOW-IT-WORKS.md)

Hook messages identify the file, review mode and actual feedback. Ordinary tool calls and Stop hooks do not repeatedly announce the same event in one session. Starting or resuming Claude explicitly recovers unfinished work; delivery is still acknowledged only through Claude's review tools.

The status bar distinguishes **Review · Verbinden**, **Review · Zustellung pausiert**, and an active feedback receiver. Readiness is separate from Claude acknowledging a comment. After upgrading, reconnect Claude once so older helpers can report the new readiness signal. A window reload reuses this project's managed **Claude · Local Review** terminal instead of creating a second session.

Connection files and submitted threads live in VS Code's workspace storage. The extension passes configuration to the session it launches, without editing your repository's `.claude` files or `.mcp.json`. Claude's existing tool permissions still apply; `/a` and `/r` are instructions to avoid edits, not a separate permission sandbox.

The command, editor action and keyboard shortcut capture code when opening a draft; that context stays fixed if the file changes while you type. VS Code's own gutter **+** exposes a new draft only when it is sent, so that path captures code at send time. Existing replies retain their thread's context. If a location cannot be identified safely, the thread opens its saved excerpt. Renamed files appear as a deletion and an addition.

## Preview status

This is an early preview. Native conversations have distinct avatars and compact status headings; the optional side composer shows one compact, syntax-colored code preview. Python, JavaScript/TypeScript, JSON and shell snippets use editor-like light/dark colors; unsupported or large snippets remain plain text. The editor icon opens native hover and reference navigation. VS Code controls native comment dimensions and typography. The project appearance action softens reply outlines using the shared contrast-border color, so other controls in that project's current theme can also receive the quieter border; high-contrast themes stay unchanged. Current checks and remaining authenticated integration work are recorded in the [review findings](REVIEW.md). The demo uses simulated responses.

The [native UX verification report](UX-REVIEW-2026-10-21.md) includes a real authenticated new/resumed Claude conversation: an inline question recalled earlier conversation context, `/R` summarized the thread, and human resolution hid it. Screenshots and a sanitized event trace distinguish these results from earlier simulated walkthroughs. Separate-terminal execution and busy-agent delivery remain unverified in this pass. [Earlier end-to-end checks](QA-2026-10-21.md).

The [daily-workflow audit](https://github.com/flucas96/local-review/issues/4) tracks follow-up work on Claude-to-thread navigation, unread replies and exact session ownership. The launcher opens VS Code's integrated terminal; the copy action supports a separate terminal. [Session connection details](CLAUDE-SESSION-ATTACH.md) distinguish resuming history from a future connection to an already-running process.

- One local workspace folder and one intended agent session.
- The background watcher expires after 24 hours; reconnect or send Claude a prompt to rearm it.
- Submitted comments persist. Optional side-composer drafts are saved in workspace storage and can be resumed explicitly; native draft recovery is managed by VS Code.
- Delivery is at least once. Event IDs reduce duplicate responses; agent side effects cannot be guaranteed exactly once after a crash.

## Contribute

[Development guide](../CONTRIBUTING.md) · [Review tracker](REVIEW.md) · [Marketplace publishing guide](PUBLISHING.md)

The manual GitHub workflows can validate and package the extension or prepare a draft release. They require explicit approval to run checks and never publish to the Marketplace.

Built on the [VS Code Comments API](https://code.visualstudio.com/api/references/vscode-api#CommentController), [Claude hooks](https://code.claude.com/docs/en/hooks), and [MCP](https://code.claude.com/docs/en/mcp).
