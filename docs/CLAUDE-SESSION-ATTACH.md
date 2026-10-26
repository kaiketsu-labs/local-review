# Connecting Claude conversations

Updated 26 October 2026 for preview 0.4.12.

## Choose the conversation

Run **Local Review: Mit Claude verbinden** in the trusted project you want to review.

| Choice | Behavior |
| --- | --- |
| **Unterhaltung auswählen** | Search recent conversations from this exact project by name or branch. Named conversations retain their names; generated titles and first prompts are fallbacks. **Läuft** marks a live process. **Weitere Unterhaltungen …** opens Claude's own picker. |
| **Neue Unterhaltung** | Launch a fresh conversation with this project's feedback connection. |
| **Laufende Unterhaltung verbinden** | Install the local integration, then connect from inside the intended running conversation. A running row in the saved picker uses this flow too. |

The first two choices use VS Code's integrated terminal. **Verbindungsbefehl kopieren** provides the same new/resume launch for a separate terminal. Copying a command does not start or stop anything. It changes to the project directory when executed, passes review settings again and preserves ordinary Claude configuration and permissions. Additional flags from a previous invocation must be supplied again on resume. See [Claude session restoration](https://code.claude.com/docs/en/sessions#what-a-resumed-session-restores).

## Connect a running conversation

Choose **Laufende Unterhaltung verbinden** in VS Code, then execute the two copyable commands in the intended Claude terminal:

```text
/reload-plugins --force
/local-review:connect
```

Requires **Claude Code 2.1.280 or newer**. The original process and conversation remain active. Loading the new tool set invalidates Claude's prompt cache, so the first command explicitly rereads the conversation context once. This is not a new conversation. The second command selects exactly the conversation in which it runs and arms automatic delivery. Wait for **Feedback aktiv** in the setup view.

The connection works independently of whether Claude runs in an integrated or separate local terminal. The authenticated end-to-end walkthrough currently covers the integrated terminal; a separate terminal application remains an additional verification task. Claude must be running at the same project root, with the same local configuration directory used by the setup CLI. Set `localReview.claudePath` if installations differ. Trusted workspace overrides are supported for both Claude and Node paths.

No terminal input is injected into an arbitrary conversation. The setup view copies only its two fixed commands. The user explicitly chooses where to execute them. The connection ticket expires after 15 minutes; repeat the VS Code setup action if it expires.

## Local setup and ownership

Claude's plugin manager registers a generated filesystem marketplace and enables its plugin with `--scope local`. Existing configuration is preserved; project enablement lives in `.claude/settings.local.json`. Plugin sources, private bridge credentials, selection metadata and tickets live in VS Code's workspace storage, outside the reviewed repository. No credentials belong in Git.

The plugin reuses Local Review's existing hooks and MCP tools. A local helper waits for saved feedback; the LLM does not repeatedly check for comments. A hook wakes Claude, and Claude acknowledges and answers through the plugin's namespaced tools. Readiness alone does not acknowledge a comment.

Only the selected session can receive or update feedback through the live plugin. The connect skill checks Claude's supplied identity against its runtime identity. Hooks, tools and the authenticated bridge all enforce the selection. Invalid selection metadata fails closed. A poll opened before a selection change is checked again before returning feedback.

An active receiver is never silently replaced. To switch away, finish or `/exit` it, allow up to 45 seconds for readiness to expire, then choose another connection. Copying a normal new/resume command keeps the existing selection intact; executing it releases only the owner captured by that command. A stale command refuses to clear a different selected session. External terminals are never killed by the extension.

After an extension update, reload VS Code and prepare/reconnect once to refresh installed helper paths. A normal bridge refresh rewrites the descriptor also used by an installed live plugin. For removal, exit the connected session, use Claude's plugin manager to uninstall the Local Review plugin for this project's **local** scope, then reload plugins in any remaining sessions. Do not remove unrelated plugins or existing Claude settings.

## Verification and limits

The [26 October QA report](QA-2026-10-26.md) records a real authenticated Claude conversation started before plugin setup, unchanged process/session identity after connecting, and an acknowledged inline question with a formatted Python reply. The source fixture remained unchanged. Repeated marketplace registration, installation and update also succeeded with the real CLI in an isolated temporary configuration.

Strict TypeScript and **256 automated tests** pass, including two competing MCP processes, selected-hook wake behavior, malformed bindings, expired tickets, stale command handoff, descriptor refresh and bounded conversation metadata. Two simultaneous authenticated Claude conversations, separate-terminal UI, busy-agent delivery, plugin removal and full application restart remain unverified combinations. Claude's existing approval controls may refuse a requested action; the integration does not bypass them.

The earlier [0.4.8 native walkthrough](UX-REVIEW-2026-10-21.md) separately established selected-session resume, retained conversational history, `/R`, inline replies and human resolution. Those results cover a resumed process rather than the new in-place connection.
