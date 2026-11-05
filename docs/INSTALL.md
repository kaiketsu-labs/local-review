# Install Pair Review

Pair Review is distributed as a VSIX preview. A Marketplace listing is not available yet.

## Requirements

| Requirement | Current support |
| --- | --- |
| VS Code | 1.100 or newer, trusted local workspace |
| Node.js | 22 or newer, available to Claude and its hooks |
| Git | Available on your computer |
| Claude Code | Installed, authenticated, with `asyncRewake` support |
| Operating system | macOS primary; Linux unverified; automatic connection blocked on Windows |

## Install the extension

1. Open [GitHub Releases](https://github.com/kaiketsu-labs/pair-review/releases) and download the attached `.vsix`. Preview releases may be marked **Pre-release**. If no release is available, a maintainer must first publish one.
2. In VS Code, open **Extensions**, choose **… → Install from VSIX…**, and select the downloaded file.
3. Open your local Git repository in a trusted VS Code window.

VS Code also supports `code --install-extension /path/to/pair-review-VERSION.vsix`. See the [official VSIX installation instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#packaging-extensions).

## Connect Claude

Run **Pair Review: Mit Claude verbinden** from the Command Palette. **Unterhaltung auswählen** shows this project's recent conversations with names, branches and a **Läuft** indicator. Search by name or branch; **Weitere Unterhaltungen …** opens Claude's own picker. **Neue Unterhaltung** starts a fresh conversation. The launcher never silently chooses the latest session.

For a conversation already running in the project, choose **Laufende Unterhaltung verbinden** (also available directly in the Command Palette). With Claude Code **2.1.280+**, Pair Review installs a local plugin using Claude's plugin manager. In the intended conversation, run the two commands from the compact setup view: `/reload-plugins --force`, then `/pair-review:connect`. Copy buttons avoid typing. The original process and conversation remain active; the reload rereads conversation context once. Wait for **Feedback aktiv**. This flow works independently of the terminal's location; the authenticated walkthrough currently covers the integrated terminal.

The previous/new choices start Claude in an integrated terminal with the review connection attached. Complete normal Claude trust or tool-permission prompts. An arbitrary terminal is never attached just because it happens to be open. Running conversations must be in this project's root directory and explicitly connected; a ticket expires after 15 minutes, after which the setup action can be run again.

After an update, reload the VS Code window and reconnect Claude once so it loads the new helpers. A normal window reload recognizes this project's existing **Claude · Pair Review** terminal. **Terminal anzeigen** reopens it. **Unterhaltung wechseln** (or **Verbindung neu starten** when delivery is inactive) explicitly replaces that managed terminal after you choose existing/new; cancelling or failing setup keeps it intact. External terminals are never closed by this action. If another receiver is active without a managed terminal, the launcher asks you to exit it first; readiness expires within 45 seconds.

### Use a separate terminal

Choose **Review → … → Verbindungsbefehl kopieren** or the same command under **Pair Review** in the Command Palette. Choose **Unterhaltung auswählen** or **Neue Unterhaltung**, then paste at a shell prompt in Terminal, iTerm or another local terminal. If Claude is running there, use `/exit` first. The command changes to the project folder and starts Claude with the same private review configuration as the integrated launcher. Copying does not start or stop a session. Keep this project's VS Code window open, and use only one review receiver for the project.

Claude's usual project configuration and tool approvals still apply. The generated command does not force a model, remove other MCP servers or bypass permissions. A copied command preserves the current live-session selection until execution and refuses to clear a different, subsequently selected session. Custom options supplied only to the old Claude invocation must be supplied again on resume; see [Claude session restoration](https://code.claude.com/docs/en/sessions#what-a-resumed-session-restores).

The status bar shows **Review · Verbinden** without a live connection, **Review · Zustellung pausiert** when only the tools are connected, and **Review** when the feedback receiver is active. Older helpers cannot report this readiness signal until reconnected. A ready connection still does not mean Claude has acknowledged an individual comment.

## Leave your first comment

Open the **Local** view in the Pair Review sidebar and click **Review local changes**. The review page lists your uncommitted changes and new files against HEAD. Click a line number, or drag across several, write your feedback and choose **Ask Claude** to discuss it or **Implement** to request a change. Typing alone does not send anything.

From the editor, select code and press **⌘⌥M / Ctrl+Alt+M**, or use **Comment in review page** in the context menu. The page opens a comment on those lines. This also works on files without changes: they open on the page whole in their own tab, marked **Not changed**, and stay while they have open threads. Clicking a file in the **Local** view shows it on the page the same way. On a PR file, the same shortcut opens a comment on that PR's review page.

Each comment keeps the code it was written on. Claude's replies appear in the same thread, with code in syntax-colored blocks. Cmd/Ctrl-click a name in the diff to peek at its definition; **Open in editor** opens the file.

Wait for Claude's reply. **Resolve** closes a thread when you accept it and **Reopen** continues it. The page updates when files change on disk.

## If the connection needs attention

| Symptom | What to try |
| --- | --- |
| Claude or Node cannot be found | Set **Pair Review: Claude Path** or **Pair Review: Node Path** to the full executable path. |
| Multiple Claude installations | Set the Claude path explicitly; different terminals may resolve different versions. |
| Running connection reports an old Claude version | Use Claude Code 2.1.280+ and set `pairReview.claudePath` to that installation. Trusted workspace settings may override both executable paths. |
| `/pair-review:connect` is unknown | Run `/reload-plugins --force` in the intended conversation after preparing the connection in VS Code. Check local plugin policy if installation failed. |
| Another conversation is selected | Finish or `/exit` the old receiver, allow up to 45 seconds for readiness to expire, then prepare the desired connection in VS Code. Automatic takeover is refused. |
| Claude has exited but the terminal remains | Run **Mit Claude verbinden** again. Use **Verbindung neu starten** when offered. |
| **Zustellung pausiert** after an update | Restart the managed connection once; older helpers do not report receiver readiness. |
| A comment remains waiting | Open the connected terminal and check Claude's startup and tool approval prompts. A live bridge is not proof that Claude acknowledged the event. |
| Repeated “Stop hook feedback” | Update the extension and reconnect Claude once. Normal hook rearming remembers events already announced in that session. Starting/resuming a session intentionally recovers unfinished work. The generic hook heading belongs to Claude Code; the message beneath it identifies the feedback. |
| More than 24 hours of idle time | Reconnect or send a prompt to Claude to rearm the watcher. |
| Context has changed | Open the thread. A saved excerpt is used when the original location cannot be matched safely. |

Keep **Pair Review: Transport** set to **hooks** for the default connection. The optional **channels** mode uses Claude's development-channel interface and depends on account availability, organization policy, and startup confirmation. Choose it before connecting a new session.

For unresolved problems, [open an issue](https://github.com/kaiketsu-labs/pair-review/issues/new/choose) with your extension, VS Code, Node, and Claude versions plus reproducible steps. Remove credentials and private code from logs before sharing them.
