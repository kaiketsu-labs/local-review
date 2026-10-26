# Install Local Review

Local Review is distributed as a VSIX preview. A Marketplace listing is not available yet.

## Requirements

| Requirement | Current support |
| --- | --- |
| VS Code | 1.100 or newer, trusted local workspace |
| Node.js | 22 or newer, available to Claude and its hooks |
| Git | Available on your computer |
| Claude Code | Installed, authenticated, with `asyncRewake` support |
| Operating system | macOS primary; Linux unverified; automatic connection blocked on Windows |

## Install the extension

1. Open [GitHub Releases](https://github.com/kaiketsu-labs/local-review/releases) and download the attached `.vsix`. Preview releases may be marked **Pre-release**. If no release is available, a maintainer must first publish one.
2. In VS Code, open **Extensions**, choose **… → Install from VSIX…**, and select the downloaded file.
3. Open your local Git repository in a trusted VS Code window.

VS Code also supports `code --install-extension /path/to/local-review-VERSION.vsix`. See the [official VSIX installation instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#packaging-extensions).

## Connect Claude

Run **Local Review: Mit Claude verbinden** from the Command Palette. **Unterhaltung auswählen** shows this project's recent conversations with names, branches and a **Läuft** indicator. Search by name or branch; **Weitere Unterhaltungen …** opens Claude's own picker. **Neue Unterhaltung** starts a fresh conversation. The launcher never silently chooses the latest session.

For a conversation already running in the project, choose **Laufende Unterhaltung verbinden** (also available directly in the Command Palette). With Claude Code **2.1.280+**, Local Review installs a local plugin using Claude's plugin manager. In the intended conversation, run the two commands from the compact setup view: `/reload-plugins --force`, then `/local-review:connect`. Copy buttons avoid typing. The original process and conversation remain active; the reload rereads conversation context once. Wait for **Feedback aktiv**. This flow works independently of the terminal's location; the authenticated walkthrough currently covers the integrated terminal.

The previous/new choices start Claude in an integrated terminal with the review connection attached. Complete normal Claude trust or tool-permission prompts. An arbitrary terminal is never attached just because it happens to be open. Running conversations must be in this project's root directory and explicitly connected; a ticket expires after 15 minutes, after which the setup action can be run again.

After an update, reload the VS Code window and reconnect Claude once so it loads the new helpers. A normal window reload recognizes this project's existing **Claude · Local Review** terminal. **Terminal anzeigen** reopens it. **Unterhaltung wechseln** (or **Verbindung neu starten** when delivery is inactive) explicitly replaces that managed terminal after you choose existing/new; cancelling or failing setup keeps it intact. External terminals are never closed by this action. If another receiver is active without a managed terminal, the launcher asks you to exit it first; readiness expires within 45 seconds.

### Use a separate terminal

Choose **Review → … → Verbindungsbefehl kopieren** or the same command under **Local Review** in the Command Palette. Choose **Unterhaltung auswählen** or **Neue Unterhaltung**, then paste at a shell prompt in Terminal, iTerm or another local terminal. If Claude is running there, use `/exit` first. The command changes to the project folder and starts Claude with the same private review configuration as the integrated launcher. Copying does not start or stop a session. Keep this project's VS Code window open, and use only one review receiver for the project.

Claude's usual project configuration and tool approvals still apply. The generated command does not force a model, remove other MCP servers or bypass permissions. A copied command preserves the current live-session selection until execution and refuses to clear a different, subsequently selected session. Custom options supplied only to the old Claude invocation must be supplied again on resume; see [Claude session restoration](https://code.claude.com/docs/en/sessions#what-a-resumed-session-restores).

The status bar shows **Review · Verbinden** without a live connection, **Review · Zustellung pausiert** when only the tools are connected, and **Review** when the feedback receiver is active. Older helpers cannot report this readiness signal until reconnected. A ready connection still does not mean Claude has acknowledged an individual comment.

## Leave your first comment

Run **Local Review: Änderungen reviewen** and select a changed file. Select a line or block, then use **Local Review: Kommentar hinzufügen**, the editor context menu, or **⌘⌥M / Ctrl+Alt+M**.

The native inline field opens at the selected lines. You can also use the gutter **+** directly. Type `/a` to ask, `/i` to request implementation, or `/r` to summarize, followed by your feedback, then choose **Senden**. Prefixes are case-insensitive and switch the request mode when sending. Bare `/r` on an existing thread summarizes it without additional text. Typing alone does not send anything.

The command, editor action and keyboard shortcut capture the code when opening the draft, preserving it if the file changes while you type. VS Code exposes drafts created with its own gutter **+** only at submission, so that path captures code when you send. Existing replies keep the conversation's original context.

Reply directly in the existing thread. The shortcut and editor action also support the original side of Local Review diffs. Native unsent drafts are managed by VS Code; the extension does not guarantee their recovery after a reload.

For live mode buttons and locally saved drafts, run **Local Review: Feedback in Seitenansicht schreiben**. This compact composer follows new nonempty selections without stealing focus. Written drafts and existing replies stay pinned; use **Neue Auswahl kommentieren** to start another while keeping the old one. Active text composition is preserved before slash switching. Bare `/r` on a new comment explains that it needs an existing conversation. **Local Review: Entwurf fortsetzen** restores the latest side-composer draft.

New Claude replies are instructed to use Markdown code fences with a language label and real line breaks. Clearly recognized standalone JavaScript/TypeScript imports and exported functions are shown in a code box even in older unfenced replies; stored answer text remains unchanged. Ambiguous syntax and other languages still need explicit Markdown fences.

Use the small **editor icon** in the reply header beside the author or beside the optional composer's code preview. Hover it for the **Code im Editor öffnen** label. Confirmed source opens in the project editor without closing the discussion. Hover symbols, use **Cmd-click** on macOS / **Ctrl-click** elsewhere, or press **F12** for definitions as supported by the language extension. If the reply is proposed code or cannot be uniquely located, **Codevorschau** opens a read-only snapshot with syntax colors; project navigation is limited. Original and captured snippets are never applied to a file by this action. A preview of an unsent draft may need reopening from that draft after a window reload.

Wait for explicit receipt and Claude's reply. Review list entries show filename, line and status; **Zur Prüfung** means the implementation is ready for your review. Use the **✓ Als erledigt markieren** action on the thread or list entry when you accept it. Completed threads disappear by default. Use the Review toolbar's **eye · Erledigte anzeigen**, then **Wieder öffnen** to continue one. The visibility preference is saved per workspace; all discussion remains stored. Human and Claude messages use distinct avatars; VS Code controls the native card layout.

For clearer unfocused comment windows, choose the **half-filled circle · Kommentarfenster hervorheben** in the Review toolbar, or run **Local Review: Kommentarfenster hervorheben** from the Command Palette. Activate it once per project. It updates four workspace color overrides for the current theme; other native comments and Peek results share that surface. **Local Review: Standarddarstellung wiederherstellen** restores prior managed values while retaining later manual edits. Dark and light themes have separate palettes; high-contrast themes keep their native appearance.

## Share selected feedback with an open PR

Install the GitHub CLI and sign in with `gh auth login` if you want PR handoffs. In the Review toolbar choose **An GitHub-PR übergeben**, select summaries and unresolved questions, review/edit the preview, and explicitly publish. This action does not acknowledge or resolve local feedback. See [PR handoff](PR-HANDOFF.md).

## If the connection needs attention

| Symptom | What to try |
| --- | --- |
| Claude or Node cannot be found | Set **Local Review: Claude Path** or **Local Review: Node Path** to the full executable path. |
| Multiple Claude installations | Set the Claude path explicitly; different terminals may resolve different versions. |
| Running connection reports an old Claude version | Use Claude Code 2.1.280+ and set `localReview.claudePath` to that installation. Trusted workspace settings may override both executable paths. |
| `/local-review:connect` is unknown | Run `/reload-plugins --force` in the intended conversation after preparing the connection in VS Code. Check local plugin policy if installation failed. |
| Another conversation is selected | Finish or `/exit` the old receiver, allow up to 45 seconds for readiness to expire, then prepare the desired connection in VS Code. Automatic takeover is refused. |
| Claude has exited but the terminal remains | Run **Mit Claude verbinden** again. Use **Verbindung neu starten** when offered. |
| **Zustellung pausiert** after an update | Restart the managed connection once; older helpers do not report receiver readiness. |
| A comment remains waiting | Open the connected terminal and check Claude's startup and tool approval prompts. A live bridge is not proof that Claude acknowledged the event. |
| Repeated “Stop hook feedback” | Update the extension and reconnect Claude once. Normal hook rearming remembers events already announced in that session. Starting/resuming a session intentionally recovers unfinished work. The generic hook heading belongs to Claude Code; the message beneath it identifies the feedback. |
| More than 24 hours of idle time | Reconnect or send a prompt to Claude to rearm the watcher. |
| Context has changed | Open the thread. A saved excerpt is used when the original location cannot be matched safely. |

Keep **Local Review: Transport** set to **hooks** for the default connection. The optional **channels** mode uses Claude's development-channel interface and depends on account availability, organization policy, and startup confirmation. Choose it before connecting a new session.

For unresolved problems, [open an issue](https://github.com/kaiketsu-labs/local-review/issues/new/choose) with your extension, VS Code, Node, and Claude versions plus reproducible steps. Remove credentials and private code from logs before sharing them.
