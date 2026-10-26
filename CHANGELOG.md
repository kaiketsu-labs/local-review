# Changelog

## 0.4.12

- Search this project's recent Claude conversations by name or branch in VS Code; show which ones are running and retain Claude's own picker as a fallback.
- Connect an already-running Claude Code 2.1.280+ conversation through a project-local plugin and two copyable commands. The original process and conversation stay active; only the explicitly selected session receives plugin feedback.
- Preserve the current selection when copying a new/resume command; release it only when that command runs, refusing a stale handoff to another selected session.
- Allow trusted workspace overrides for Claude and Node executable paths and report an outdated Claude version before installing the live plugin.
- Add the organization README banner, quick-start choices and connection documentation. Keep credentials and runtime connection files outside Git.
- Pass strict TypeScript and 256 tests. Verify authenticated attachment and a formatted inline reply in VS Code with unchanged process/session identity; record remaining cross-terminal and competing-live-session checks separately.

## 0.4.11

- Remove VS Code's inherited inline-code background strips and padding from the composer preview, keeping one clean syntax-colored code card.
- Reuse an existing source editor when opening code from the composer, including a source displayed in a diff. Repeated navigation no longer creates extra editor columns.
- Reset preview scrolling when changing the selected code target, while preserving the reading position when reopening the same target.

## 0.4.10

- Replace the bulky side-composer context stack with one compact file reference, editor icon and syntax-colored selected-code card. Remove duplicate surrounding context, branding and the pinned-reply badge from the display; captured context stays attached to feedback.
- Highlight Python, JavaScript, TypeScript, JSON and shell snippets in light and dark themes. Unsupported or large snippets remain escaped plain text; previews preserve the exact source.
- Soften the native reply surface and outline, and label its entry action **Antworten …**. The project appearance action uses VS Code's shared contrast-border color, preserves high-contrast themes, and can restore older appearance backups.

## 0.4.9

- Shorten the conversation-picker hint so the required `/exit` instruction stays visible in the native dialog.
- Make Node startup failures report the selected executable and bounded failure details instead of implying every failure is a path problem.
- Explain that a connection may still be disconnecting for up to 45 seconds after Claude exits, without incorrectly reporting another active session.

## 0.4.8

- Choose a specific saved Claude conversation through its native session picker, or start a new one. Resume keeps history and replaces the previous automatic “latest conversation” selection.
- Copy a safely quoted project-aware connection command for a separate terminal, with the same existing/new choices and private review configuration.
- Make managed-session switching explicit, preserve sessions when selection is cancelled or setup fails, and avoid launching over an active external feedback receiver.
- Explain that an already-running conversation must currently be exited and resumed; in-place plugin attachment remains unverified follow-up work.

## 0.4.7

- Keep existing native comment objects during status updates; show filename and line in the Review list, and expose the contrast action directly in its toolbar.
- Add optional **Zentrierte Ansicht** in the Review overflow menu, using VS Code's native centered layout to narrow source and inline comments together. Independent native comment width is unavailable; diffs may still expand automatically.
- Preserve code captured by command-created inline drafts while the source changes; reopen saved context when a safe current match is unavailable. VS Code's own gutter drafts still capture context at send time.
- Preserve active text composition in the optional composer and PR preview; explain bare `/r` on a new side-composer comment without changing the existing-thread shortcut.
- Keep edited or failed PR handoffs recoverable after closing within the current VS Code session, retaining their exact snapshot; explicitly choose a new snapshot when needed.
- Mark post-publication edits as unpublished, prevent repeated sends of unchanged published text, and improve PR-preview wrapping in narrow panes.
- Distinguish automatic-delivery readiness from MCP activity and event acknowledgments. Older helpers require a reconnect to report readiness; reuse the project's managed terminal after an editor reload.
- Write private connection settings atomically. Strict TypeScript and 210 automated tests pass; native and live-agent evidence is tracked separately in the QA report.

## 0.4.6

- Keep appearance actions responsive while success, high-contrast or error notifications remain open. Restoring or reapplying project colors no longer waits for a notification to be dismissed.
- Verify the distinct native thread surface and darker reply field in a real dark-theme workspace, including after focus leaves the reply field.

## 0.4.5

- Add a project-scoped appearance action that gives native review conversations a distinct surface and persistent neutral frame, including when unfocused.
- Preserve unrelated colors and theme settings; restore prior project values with a separate reset action, retaining later manual edits.
- Scope the contrast colors to the current dark/light theme and retain native high-contrast colors.

## 0.4.4

- Add end-to-end regression evidence for silent unacknowledged rearming and live bridge replacement; record a real headless Claude ask/implement/summarize roundtrip separately from pending interactive UI checks.
- Remember hook deliveries per Claude session so normal tool/Stop rearming does not repeatedly wake Claude for the same unacknowledged comment; explicitly recover unfinished work on session start/resume.
- Lead hook messages with file, mode and a short feedback excerpt, sharing the formatting/action contract once per batch; ignore subagent hooks.
- Keep superseded events as conversation history instead of reviving them as fresh work after the latest request is complete.
- Hide resolved conversations from native editor comments, the Comments panel and Review list by default; add a saved show/hide control and quick resolve/reopen actions.

## 0.4.3

- Format obvious legacy JSDoc comments attached to exported JavaScript/TypeScript declarations as code cards, including a standalone function header ending at its opening brace.
- Preserve the original snippet, surrounding explanation and saved review text; never invent a missing function body or closing brace.
- Clarify that agent reply formatting also applies to doc comments and incomplete function headers.

## 0.4.2

- Move the code-reference icon to the native comment header beside the author and timestamp; remove the extra action row from reply text.
- Open single code targets directly and use one compact picker for replies containing multiple code blocks.
- Bind header actions to extension-owned native comments; reply Markdown no longer needs permission to run commands.

## 0.4.1

- Present native code blocks as darker rounded cards with a visible frame, real inner spacing and a compact file/language header; stored code remains unchanged.
- Replace long native code-navigation links with compact editor icons and descriptive tooltips.
- Shorten selection and PR-preview copy; use an accessible editor icon in the side composer too.
- Reduce the repeated reply-format reminder from 562 to 118 characters; keep the full contract on the reply tool.
- Redraw the flow as a clean, neutral code-review loop focused on collaborating with an agent.
- Explain the workflow in plain language and document existing macOS Dictation for comment input.

## 0.4.0

- Display clearly recognized, unfenced JavaScript/TypeScript declarations in a code box, including existing replies; keep original stored text and explanatory prose intact.
- Accept uppercase `/A`, `/I` and `/R` shortcuts as well as lowercase ones.
- Use clear system UI and monospace fonts in extension-owned panels; avoid inheriting novelty fonts.
- Add an illustrated feedback flow and explain local long polling, automatic hook delivery, MCP replies and the separate GitHub handoff.
- Give unlabeled fenced code the review file's language for native VS Code syntax coloring, without changing stored replies.
- Add **Im Editor öffnen** actions to reply code blocks and the optional composer's selected code.
- Open confirmed, uniquely matching current project code in its existing editor, retaining the chat and its draft. Native hover, Cmd/Ctrl-click and F12 then use the installed language support.
- Show proposed, changed or ambiguous code in a read-only syntax-colored preview instead of guessing a source location. Project semantics are limited there; native Markdown code blocks remain display-only.
- Validate generated code links through opaque session handles and re-read durable review data on every click. Reopen saved review snippets after a window reload.

## 0.3.1

- Add distinct human and Claude avatars to native conversations, including the identity beside inline replies.
- Shorten thread headings and status labels while preserving delivery and review states.
- Restyle the optional side composer with a single rounded input card, mint accents, quieter code context, clearer file hierarchy and compact actions.
- Preserve theme colors, visible keyboard focus, explicit high-contrast borders and narrow-panel wrapping. Native comment layout remains controlled by VS Code.

## 0.3.0

- Make native inline input the default: gutter plus, direct replies, one send action and `/a`, `/i`, `/r` shortcuts evaluated on send.
- Restore commenting ranges on local files and both sides of Local Review diffs.
- Keep the optional side composer open after sending, follow explicit new selections without focus changes, and preserve written drafts on their original code.
- Highlight the accepted selected lines independently of editor focus and separate selected code from surrounding context.
- Make the side composer smaller with a compact header, mode buttons, bounded code preview and content-sized input.
- Require Markdown code fences, indentation and real line breaks in agent replies; add a formatted-code MCP round-trip regression.
- Share in-flight inline submissions, preserve replies on saved code context, and prevent discarding a draft during submission.
- Add ten composer protocol regressions and four submission gate regressions. Strict TypeScript checking and all 73 automated tests pass.

## 0.2.1

- Add a mint-on-navy extension icon matching the demo's code-and-conversation identity.
- Include a matching monochrome Review view icon and package both assets in the VSIX.

## 0.2.0

- Add a controlled feedback composer with visible live `/a`, `/i`, and `/r` mode switching and one explicit send action.
- Save unsent drafts in workspace storage and offer explicit draft recovery.
- Keep submitted conversations inline and open replies through the same composer.
- Support feedback shortcuts on original-side Local Review documents.
- Add a separate preview-and-publish action for summaries and unresolved questions on the current branch's GitHub PR, with managed-comment updates.
- Revise the staged demo to begin with Claude coding, then review feedback, and add an original quiet ambient soundtrack.

## 0.1.1

- Preserve comment drafts when submission fails.
- Restore threads only on confirmed code locations and display saved context when uncertain.
- Keep comparison editors open while navigating review conversations.
- Reconnect after Claude exits, and rearm delivery after tool use.
- Bound new feedback before persistence and isolate legacy oversized review context.
- Recover unfinished work when a channel reconnects.
- Summarize existing threads without requiring additional text.
- Show renamed files as separate deletion and addition for complete local review.
- Add targeted regression cases, GitHub installation/publishing documentation, and a staged demo.

## 0.1.0

Native inline reviews with automatic per-comment delivery to Claude Code, persistent threads, explicit acknowledgments, and replies in the editor.
