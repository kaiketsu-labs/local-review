# Review findings and verification

Reviewed on 20–21 October 2026. **Fixed** means a source change has been made. **Verified** requires recorded execution evidence; a static review or a staged demo does not establish it.

Latest evidence: [0.4.7 UX review](UX-REVIEW-2026-10-21.md), including **210 passing automated tests**, an actual VS Code click-through with controlled agent replies, and responsive PR-preview checks. Earlier authenticated Claude and hook evidence remains in the [end-to-end report](QA-2026-10-21.md). These evidence types are recorded separately.

Update 26 October: [0.4.12 running-conversation QA](QA-2026-10-26.md) records 256 passing tests and authenticated in-place connection with unchanged process/session identity, an acknowledged native inline question and a formatted reply. The organization repository now has a redesigned README and copied release history.

## Findings

| ID | Priority | Finding | Source status | Verification |
| --- | --- | --- | --- | --- |
| LR-001 | P1 | A failed submission could clear the native draft because the command swallowed its rejection. | Fixed: report the error and preserve the rejected promise. | Pending: native composer walkthrough with failed persistence. |
| LR-002 | P2 | After reload, a moved comment could attach to its old line number in unrelated code. | Fixed: match the captured context or show a saved excerpt. | Pending: anchor tests and extension-host walkthrough. |
| LR-003 | P2 | Reconnect only revealed a terminal after Claude had exited. | Fixed: observe command completion and offer an explicit restart. | Pending: exit, failed startup, and reconnect walkthrough. |
| LR-004 | P2 | An oversized field could poison the transport batch and block unrelated comments. | Fixed: shared field bounds and bounded projection of legacy data. | Pending: boundary and recovery tests. |
| LR-005 | P2 | Growing conversation history was forwarded without a context budget. | Fixed: quote up to 20 recent messages within 100,000 characters. | Pending: context-budget tests. |
| LR-006 | P2 | The summary action was disabled when an existing thread's composer was empty. | Fixed: `/r` can summarize the existing conversation. | Pending: native comment-action walkthrough. |
| LR-007 | P2 | Sidebar navigation opened a plain file rather than the review diff. | Fixed: thread navigation restores the review diff when possible. | Pending: native diff navigation walkthrough. |
| LR-008 | P2 | Rename detection hid the original path, leaving the new path with an empty base. | Fixed: represent a rename as deletion plus addition. | Pending: staged-rename regression. |
| LR-009 | P2 | A transport test expected unfinished acknowledged work to disappear from recovery. | Fixed: expect it until an actual answer arrives. | Pending: test execution. |
| LR-010 | P2 | Watcher rearming during ongoing tool use needed additional robustness coverage. | Fixed: also arm on `PostToolUse`; a live-host delivery failure has not been reproduced. | Pending: hook regression and consecutive-comment walkthrough. |
| LR-011 | P2 | Channels startup or reconnection skipped acknowledged but unfinished work. | Fixed: recover from `/pending` before polling new events. | Pending: channels recovery test and live walkthrough. |

Implementation and tests are in [src](../src) and [test](../test). Use the issue IDs above when recording follow-up work.

## Daily-workflow usability audit

Three independent read-only audits of preview `0.1.1` (`1765984`) identified the following open gaps. These are source findings; host behavior still needs the live walkthrough in [#1](https://github.com/flucas96/local-review/issues/1). Acceptance criteria and implementation options are tracked in [daily-workflow usability #4](https://github.com/flucas96/local-review/issues/4).

| ID | Priority | Open gap | Recommended change |
| --- | --- | --- | --- |
| LR-012 | P1 | Claude cannot directly open the original review thread. | An authenticated `open_review(event_id)` MCP tool reusing existing diff/thread navigation. |
| LR-013 | P1 | Replies update the UI but have no unread state or next-answer action. | Unread/ready count, optional actionable notification, and keyboard navigation without automatic focus changes. |
| LR-014 | P1 | MCP heartbeat can show connected independently of a working wake hook. | Fixed in 0.4.7: separate receiver readiness, expire it independently, and offer reconnect while preserving explicit ACK semantics. Process tests pass; native connected/receiver states observed. |
| LR-015 | P2 | Separate terminal support and already-running process attachment. | 0.4.12 adds an explicit in-conversation connection through a local plugin. Native authenticated in-place attachment and reply passed; separate-terminal UI remains unverified. |
| LR-016 | P2 | Session ownership and conversation selection. | 0.4.12 adds a searchable project conversation list, live indicators and selected-session guards for plugin hooks, tools and the bridge. Competing MCP/hook processes pass isolation tests; two authenticated sessions and owner display remain follow-up checks. |
| LR-017 | P2 | Required Claude wake capability is not checked during setup. | Live setup now requires Claude 2.1.280+ with an actionable version/path error. Legacy launch capabilities still rely on installed Claude support. |
| LR-018 | P2 | Review file selection is HEAD-relative and opens one file at a time. | A stable review baseline and next/previous-file navigation; committed work must remain reviewable. |
| LR-019 | P2 | The flat queue hides filename/line in a tooltip and includes all resolved threads. | Fixed: visible filename:line in 0.4.7, saved resolved filter and quick actions in 0.4.4. Native hide/show/reopen repeated in 0.4.7. Unread tracking remains LR-013. |
| LR-020 | P2 | A slash prefix can override the clicked intent button without a preview. | Source fixed in 0.2.0: controlled composer previews live mode and uses one send action; native walkthrough pending. |
| LR-021 | P2 | Add-comment shortcut and context action exclude original-side virtual documents. | Source fixed in 0.2.0: include `local-review-base`; removed/original-line walkthrough pending. |

The recommended first pass is direct thread navigation, reply visibility, and truthful delivery readiness. Both integrated and separate local terminal apps should use the same review protocol. Claude's built-in `/ide` connection does not by itself install this extension's review hooks or MCP tools.

## Live modes and PR handoff

Preview 0.2.0 adds a controlled composer beside the diff because stable native comments expose text only when a comment is submitted. Typing an exact `/a`, `/i`, or `/r` previews the mode immediately; whitespace commits the shortcut. `/api` and `/index` remain ordinary text. Mode buttons explicitly override a pending prefix. Closing the composer keeps its local draft; submitted conversations remain native inline threads. These source changes and tests are not evidence of a completed native walkthrough.

The separate PR action selects conversation summaries and unresolved questions, prepares an editable snapshot, and publishes one managed user-owned PR discussion comment. Summaries from resolved conversations are available only through explicit selection and are not preselected. It does not fabricate summaries, map unpushed lines to the PR diff, or resolve local threads. Managed markers support retry recovery and updates, but concurrent clients can still race; duplicate managed comments require manual attention. Validation and the updated demo are tracked in [feature issue #5](https://github.com/flucas96/local-review/issues/5).

## 0.3.0 usability and verification

The user selected native GitHub-style inline input as the default, accepting mode interpretation at send time. The gutter provider is restored, inline replies are enabled, and one **Senden** action parses `/a`, `/i`, `/r`. The smaller side composer remains available as an explicit alternative, with live mode switching, local draft storage, selection following and a persistent accepted-range decoration. Written drafts and replies do not silently retarget.

The side composer now shows the exact selected lines; surrounding context is separate and collapsed. Native replies use VS Code's Markdown renderer. Inspection of the playground's existing reply metadata confirmed real newlines but no fenced code blocks. Shared agent instructions and tool metadata now require fenced, language-labeled code. Existing reply bodies remain unchanged.

With user approval on 20 October 2026, strict TypeScript checking passes and **73 automated tests pass**. This includes ten tests executing the actual composer host and embedded browser script with a minimal VS Code/DOM fake, four submission gate regressions, and an MCP/bridge/storage round trip preserving fenced multiline JavaScript. The first restricted run could not open loopback ports; rerunning with loopback access succeeded. One old transport test incorrectly expected a completed thread in the pending-only payload and now checks durable storage instead.

On macOS, the 0.3.0 VSIX was installed over 0.2.0 in the user's VS Code and the playground window reloaded. The add-comment shortcut opened a native field on line 6; entering `/i ` enabled the single **Senden** button. The temporary text was cleared and its draft discarded. Clicking the visible gutter plus on the same line also opened a focused native field with the shared slash-command placeholder and one disabled send button while empty. No test feedback was sent to the authenticated Claude session. Existing stored conversations remained visible after reload.

## 0.3.1 chat styling

Native comments now use distinct human and Claude SVG avatars, including the identity beside reply input. Compact headings preserve the existing delivery and review states. The optional side composer uses a rounded joined input card, mint borders/tints, a clearer file path, quieter code disclosure and compact actions. It inherits editor/theme surfaces and foreground, retains visible keyboard focus, and defines high-contrast borders and narrow-panel wrapping. Native spacing, fonts and card CSS remain owned by VS Code; no user theme settings are modified.

Strict TypeScript checking and all 73 existing regressions pass after the visual changes. Packaging includes both author SVGs. The installed version was confirmed as 0.3.1 in the user's macOS VS Code, then the playground window reloaded. A stored implementation thread rendered both message avatars plus the human reply avatar, with the shorter status heading. Opening its optional reply composer rendered the rounded card, `retry.js:9`, pinned-reply state, selected implementation mode and disabled send button while empty. The current dark theme was visually reviewed; light/high-contrast themes and narrow widths still need a visual walkthrough. No feedback was sent during this styling check.

## 0.4.0 code display and editor navigation

Code fences in native comments use VS Code's own Markdown syntax renderer. Unlabeled fences inherit the review file's language for display; persisted reply text is unchanged. Native Markdown code remains display-only. Hover information and definition/reference navigation are supplied by the installed language extension after opening the real project document.

Generated actions above reply code blocks and beside the optional composer's code preview open the editor without submitting feedback or clearing a draft. They match complete code lines against current in-memory source, including unsaved edits, and use captured context only when confirmed. Missing or ambiguous matches open a read-only **Codevorschau**, with syntax language selected from installed support. Project navigation is limited there. Saved review previews recover from durable messages after reload; a preview belonging only to an unsent draft may need reopening from that draft. A bounded, display-only recognizer wraps obvious standalone JavaScript/TypeScript imports and exported functions, including legacy answers. It preserves code bytes, prose, existing fences and persisted messages. It is not a full language parser; ambiguous constructs and other unfenced languages remain unchanged.

Editor actions use opaque session handles, one allowlisted command, and durable identities revalidated on every click. Browser/model-supplied paths cannot select the target. The first 20 nonempty fenced blocks in one message receive direct actions.

Strict TypeScript checking and **131 tests pass**. New coverage includes twenty fence/language/detection cases, twelve source-matching cases, nine opaque-reference cases, five composer navigation cases and eight actual-navigator boundary cases, plus four uppercase-shortcut regressions. These cover duplicate code, moved lines, final blank lines, CRLF, stale IDs, proposal previews, draft preservation, keeping a lone chat visible, reload recovery and awaiting editor operations. The production bundle and VSIX build successfully.

In the actual macOS playground, 0.4.0 was installed and activated by reloading VS Code. A generated action in an existing Claude reply opened the current project file at line 9. Native hover displayed `let attempt: number`; F12 navigated to its declaration at line 5. Another stored conversation referred to older code: its action opened the captured code in a separate, syntax-colored preview and reported limited project navigation. The navigation checks did not submit feedback. During manual draft cleanup, a focus error cleared the open source buffer. Its exact 694-byte pre-check version was recovered and restored, and the intervening Claude-generated version was backed up separately. A fresh authenticated reply containing fenced code remains to be checked visually in the native comment itself; parser/rendering tests and local VS Code renderer inspection cover the implementation.

On 21 October, the final VSIX was installed and the playground reloaded. The previously unfenced reply from the user's screenshot now rendered its import and retry function together as a distinct syntax-colored, monospace code block, separated from explanatory prose. Its generated editor action was visible. The locally saved navigation-test draft was resumed, identified by its exact test text, and discarded with its own button; no new feedback was sent. The restored source remained intact. The flow diagram was rendered from SVG to PNG and visually checked for readable text, icons, arrows and clipping. The PNG is included in the VSIX because the package validator rejects SVG images in README files.

Extension-owned composer and PR panels use shared system sans-serif and monospace font stacks. Native comment typography remains controlled by VS Code. ASCII uppercase `/A`, `/I`, `/R` now follow the same shared parser as lowercase shortcuts, without changing feedback text.

## 0.4.1 compact actions and guidance

Native code cards add a theme-aware darker background, rounded corners and a compact file/language header around real Markdown fences. Approved layout cells provide inner spacing and expose a surrounding theme-colored frame; the native sanitizer strips arbitrary CSS borders and padding. Original HTML is neutralized before enabling generated safe markup. Inline-code/autolink and metadata boundaries have dedicated regressions; rare multiline inline-code angle brackets are conservatively entity-escaped. Stored code and navigation indexes remain unchanged. Assistive-technology behavior of the generated layout tables still needs a dedicated walkthrough.

Native code actions use a small themed editor icon, with descriptive hover titles and numbers only when several code blocks need separate targets. The optional composer has the same compact action as an accessible SVG button. Selection notices and PR preview copy are shorter; explicit send and publish actions remain unchanged.

The first dark-surface variant was rejected during visual review because it lacked a visible frame and inner spacing. The revised installed bundle was reloaded in the user's actual macOS VS Code. The existing retry reply showed a surrounding gray frame, rounded dark surface, inset file/language header and inset syntax-colored code. Scrolling the native message revealed its closing lines, lower frame and separate explanatory prose. The full import line remained visible in the current split layout. No new feedback was submitted; the restored source hash remained unchanged. Light/high-contrast themes, very narrow widths and assistive-technology behavior remain unverified.

The full reply-format contract remains on the MCP reply tool. Wake-up events now include a 118-character reminder rather than the previous 562-character paragraph. No session flag suppresses it after reconnect, clear, fork or context compaction. Existing channel and hook integration tests verify both the short reminder delivered to Claude and the complete tool description. Strict TypeScript checking and all **138 automated tests pass** for 0.4.1.

macOS Dictation is documented as the user's existing text-input method. No recorder, audio upload, transcription provider or system-setting change was added; audio capture was not activated during verification.

The revised 1440×1260 flow graphic uses neutral light surfaces, charcoal and restrained teal. Four small code/review scenes show the human-agent cycle: inspect changes, comment in context, discuss or change, then check and finish. It was rendered from SVG to PNG and visually reviewed at full and README-like widths for readable code, arrows and clipping. Explanatory transport details are collapsed in the accompanying guide.

## 0.4.2 code action in the comment header

The code-reference icon now uses the native comment-title toolbar on the author/timestamp row. No generated navigation link or action row is inserted into message text. One target opens directly; replies with several nonempty code blocks offer a bounded native picker with language and a short code preview. Cancelling it leaves the editor alone.

The header command accepts only native comment objects bound by the extension, then uses opaque handles and the existing durable-message/source validation. Reply Markdown no longer grants any command trust. Strict TypeScript checking and all **142 automated tests pass**, including header-object identity, stale targets, multiple-block selection, cancellation and context-only replies.

Version 0.4.2 was installed in the user's actual macOS VS Code and activated by reloading the playground. The stored retry reply showed the editor icon on Claude's author/timestamp row, with explanatory text immediately below and no body action row. Clicking the header icon opened the exact historical snippet as a syntax-colored read-only preview beside the discussion, preserving the thread and current source. The existing code card frame and inner spacing remained visible. Multiple-target selection and cancellation are covered by automated tests; a native multi-target picker walkthrough remains pending. No feedback was submitted.

## 0.4.3 documented function excerpts

An existing ask reply contained a complete JSDoc comment followed by only `export async function withRetry(operation) {`, without Markdown fences. The previous display recognizer accepted complete imports/functions only, so this excerpt stayed plain prose. Display repair now recognizes one complete attached JSDoc comment and either its complete supported exported declaration or an isolated function header. It preserves snippet bytes, adds no function body/closing brace and keeps the following explanation outside the code card. Ambiguous prose, malformed documentation/parameters and incomplete function bodies remain unchanged.

Strict TypeScript checking and all **150 automated tests pass**. New regression coverage includes the exact stored reply, complete documented functions, CRLF/nested parameters, prose mentioning a closing brace, malformed/unattached docs, TypeScript body starts, existing fences and HTML boundaries. An integration regression exercises the real Markdown/header-action pipeline, exact read-only snippet navigation and preview recovery after navigator recreation without changing stored review text. The full reply-tool instructions now mention doc comments and incomplete headers; the short repeated wake-up reminder is unchanged.

Version 0.4.3 was installed in the user's macOS VS Code and the playground reloaded. The exact 12-hour-old ask reply was opened from Comments: its JSDoc rendered green and the function header syntax-colored on the next line inside the existing dark framed/inset card. Both explanatory paragraphs stayed outside; the editor icon remained on Claude's header row. Clicking that icon opened the original two-line excerpt as a code preview without completing its missing body. No feedback was submitted during this check.

## 0.4.4 quieter delivery and completed reviews

The previous hook waiter forgot which events it had emitted whenever a Stop/tool hook rearmed it. Until Claude acknowledged an event, the same feedback could therefore wake it repeatedly. Private session receipts now track emission separately from the durable acknowledgment. Every decision uses a complete current pending snapshot; the long poll only wakes that check. New event IDs remain deliverable even after a store sequence reset. SessionStart explicitly replays unfinished current work, including an acknowledged working request. Subagent hooks cannot claim the workspace watcher. Receipt metadata is bounded to current pending IDs, 32 sessions and 30 days; corrupt metadata permits replay instead of hiding work.

The hook message starts with mode, file/lines and the actual feedback excerpt. Its complete bounded JSON context remains available, with shared action/formatting instructions once per batch. Superseded requests remain in durable history and current conversation context, but cannot revive as fresh actionable work after the latest request finishes. No hook emission acknowledges work or resolves a thread.

Resolved threads are hidden by default from native editor comments, the Comments panel and the Review tree. One saved workspace filter restores them. Inline tree actions offer resolve/reopen, while asynchronous restoration/reveal rechecks the latest visibility state. Resolving during an in-flight native submission is blocked until its save completes. Existing side-composer drafts are retained.

Strict TypeScript checking and all **167 automated tests pass**, including real child-process hook delivery, unacknowledged Stop/tool rearming, new feedback, same-session resume/new-session recovery, subagent routing, corrupt receipts, superseded history and saved visibility/failure handling. Peer audits found no material blocker. Receipt persistence and Claude's exit-code reception are not atomic: interrupted delivery can still replay or require SessionStart recovery. An already running Claude session retains its old hook path/process and must reconnect after updating.

Version 0.4.4 was installed and activated in the user's actual macOS VS Code. Two previously resolved conversations disappeared by default; the eye control restored all six discussions. On the existing answered “add a comment here” thread, ✓ removed its inline card, native Comments entry and Review entry and reduced the unresolved count from four to three. Showing completed discussions restored it with **Wieder öffnen**; reopening restored the prior answered/open state and count of four. The default hidden filter was restored afterward. No new feedback was submitted, and the playground source hash remained unchanged. The existing dark framed code card and header editor icon were visually intact. The current Claude process was retained; the updated live hook still requires reconnecting.

## 0.4.5 unfocused conversation contrast

An explicit **Kommentarfenster hervorheben** action applies four project color overrides for the current theme. Native conversations receive a distinct surface, darker reply field and persistent neutral border. VS Code shares these colors with other native comments and Peek results in the project. The extension does not change settings at activation; a separate reset restores the previous managed values and preserves later manual edits. High-contrast themes keep their native colors.

Strict TypeScript checking and **183 tests pass**, including 14 command-level appearance regressions. A peer audit found and fixed a concurrent-settings race: changes made while the backup is being saved abort the operation before the settings write and restore the prior ownership metadata. Tests cover a manual color matching the planned palette and preservation of an earlier successful theme backup.

The later native check activated the appearance action in the local Review Lab workspace using Dark+. Its existing answered Python thread gained a visibly distinct surface, darker reply input and neutral top/bottom frame. Focus/blur clicks confirmed that the input remains visible after its blue focus outline disappears. The project had no overrides before applying the action, which explains why installing 0.4.5 alone had not improved its appearance.

## 0.4.6 appearance action completion

Native testing found that reset could wait indefinitely for an earlier success notification to close. The serialized mutation queue awaited VS Code's notification lifetime. Terminal success, high-contrast and error messages are now dispatched without awaiting dismissal; backup and settings writes remain serialized and awaited. Strict TypeScript checking and **185 tests pass**, including two regressions with intentionally unresolved notifications.

Native apply and focus/blur passed with the unchanged palette. The corrected reset/reapply sequence and activation of 0.4.6 remain pending because subsequent computer-control attempts reported no available VS Code window. See [the QA record](QA-2026-10-21.md) for the exact evidence and limits.

## Verification still required

- Repeat relevant checks after future changes. Automated coverage does not replace native extension-host or authenticated integration validation.
- Continue the native walkthrough beyond the verified installation, shortcut, gutter-plus, resolve/show/reopen and input checks. Exercise live side-composer mode switching, `/index` text, local draft recovery, failed submission, all three submitted actions, empty-thread summary, reply, original-side commenting and sidebar navigation.
- Exercise PR handoff with no PR, missing CLI/authentication, selected summaries/questions, stale summaries, unpushed code, editable preview, successful publication, managed updates, changed destination/account, retry after uncertain publication and duplicate managed comments. Confirm publication does not change local delivery or resolution.
- Connect an authenticated Claude terminal. Confirm idle wake-up, a second comment during ongoing work, explicit acknowledgment, progress, and a reply in the correct thread.
- Reload the extension, move code, rename and delete files, and confirm safe thread recovery. Verify that a stalled or exited session can reconnect.
- Exercise Linux before claiming support. Windows connection requires implementation and a dedicated walkthrough.

## Current limits

| Area | Limit |
| --- | --- |
| Session | First local workspace folder and one intended Claude session. Remote and concurrent agent sessions are unsupported. |
| Platform | macOS is primary. Linux is unverified. Automatic connection is blocked on Windows. |
| Idle watcher | 24-hour timeout. Reconnect or send Claude a prompt afterward. |
| Agent context | Up to 20 recent conversation messages and 100,000 quoted characters. Individual review fields are bounded at 200,000 characters; replies at 20,000. |
| Large backlog | Aggregate transport responses still have a 10,000,000-character ceiling and no pagination. A sufficiently large open queue can exceed it. |
| Drafts | Submitted threads and optional side-composer drafts persist. Native draft recovery is managed by VS Code. If side-draft cleanup fails after a successful send, a stale draft can remain after restart; it is never automatically replayed. |
| Delivery | At least once. Acknowledgment and reply IDs reduce duplicates; arbitrary edits are not exactly-once operations. |
| Permissions | Ask and summarize are agent instructions. They do not create a separate filesystem permission boundary. |
| Demo | Staged interface and simulated responses, not live integration evidence. |

## Release status

Open work is tracked in GitHub: [validation and live integration #1](https://github.com/flucas96/local-review/issues/1), [Marketplace publisher and listing #2](https://github.com/flucas96/local-review/issues/2), [large-backlog pagination #3](https://github.com/flucas96/local-review/issues/3), [daily-workflow usability #4](https://github.com/flucas96/local-review/issues/4), and [live modes, PR handoff and demo #5](https://github.com/flucas96/local-review/issues/5).

The `0.4.7` bundle and strict TypeScript checking pass, as do all 210 automated tests. The VSIX is installed in the user's VS Code. This release adds native input-to-reply checks with controlled responses for all three modes, resolve/show/reopen, code navigation and responsive rendering of the production PR preview. Earlier authenticated headless Claude, hover and F12 evidence remains recorded above. A complete authenticated interactive run, real PR publication walkthrough, publisher registration and Marketplace publication remain pending. Manual GitHub Actions workflows have not been run. See the [current UX report](UX-REVIEW-2026-10-21.md) for precise evidence and remaining limits.
