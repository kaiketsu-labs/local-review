# Changelog

## Unreleased

- Local changes have their own review page. **Review local changes** in the new **Local** view shows your uncommitted changes and new files against HEAD with the same comment boxes, threads, Viewed marks and definition peeks as a PR. Comments still go to the Claude session you connected, and its replies appear in the thread. The page reads the files again when they change on disk.
- The **Local** view replaces the **Review** view. It lists the repository's files with Git's change marks and each file's open comments. Clicking a file shows it on the review page. A file without changes opens whole in its own tab next to **Changes**, with its icon from your file icon theme and one column of line numbers, until you close the tab or while it has open threads.
- Removed: native inline comments in the editor, the **⌘⌥M / Ctrl+Alt+M** shortcut and the editor's comment command, the side composer and its drafts, the `/a`, `/i` and `/r` prefixes, the Review view with its contrast and centered-layout actions, **Änderungen reviewen**, and the **An GitHub-PR übergeben** handoff. Comment on the review page by clicking a line number, and use **Ask Claude** and **Implement** there. Existing local threads appear on the review page.
- The **Local** view lists every checkout when there is more than one: the window's folders, repositories nested in them, their Git worktrees (such as Claude Code's under `.claude/worktrees`) and the worktrees of PRs you opened. Checkouts sit under one row per repository, which shows how many there are: opened folders first, then worktrees by branch, then PRs by number. The filter button in the view's title bar keeps checkouts whose repository, branch, or PR number or title contains your text; the view remembers it per workspace. **Review local changes** on a row opens that checkout's own review page tab, with its own comments, Viewed marks and Claude connection, so you can review several branches side by side. Clicking a file of a PR worktree opens it on that PR's review page, whole in its own tab when the PR does not change it.
- When the branch of a local review page has an open PR of yours, a **PR #N** chip appears next to the branch. Clicking it turns the same tab into the PR's review page on your own checkout, without a separate worktree: your threads and Viewed marks stay, and comments keep going to the Claude conversation you connected. The checkout never moves on its own there. When GitHub has newer commits, the page says to pull them; **Commit suggestion** makes a local commit for **Push** instead of pushing right away; **Fix conflicts** and **Remove worktree** are left out, so ask your conversation to fix conflicts.
- File tabs on the review page stay on one row with the toolbar. **Changes** and **Guide** stay in place while the file tabs scroll, a newly opened file's tab goes last instead of in name order and scrolls into view, and file tabs use a smaller font.
- Opening a file on the review page is faster. Pair Review keeps the colored code of files it already showed, so opening another file no longer colors every changed file again: on a 23-file change it took about 1.2 s each time and now takes about 0.1 s after the first.
- **Connect Claude** on the local review page opens a menu on the page instead of VS Code pickers: **New conversation**, **Resume a conversation…** with a searchable list of this folder's conversations, **Connect running Claude** with the two commands to run and copy buttons, and **Copy command**. Once connected, the button reads **Open in terminal** and the menu shows the terminal or switches conversations.
- On a PR's review page, a file outside the diff that has open Local threads gets its own tab, like an unchanged local file, so its threads show on the page. Opening a resolved one from **Threads** adds its tab. If a later commit deleted the file, the tab shows the code saved with its threads, marked **Saved code**.
- The review page asks its questions in the page instead of VS Code dialogs. **Close pull request**, **Delete branch** and **Revert** turn their row into the question with **Cancel** and a confirm button; deleting a comment asks under the comment. **Remove worktree**, **Discard**, **Approve and run** and a new base branch ask in a small menu under their button. Hiding a comment picks the reason from a menu under **Hide**, **Update branch** picks merge or rebase from a menu, and **Edit title** and **Dismiss review** edit in place. **Revert** reports the new PR in the page notice with a link.
- **Merge** is its own confirm button: the first click opens the commit message and turns it into **Confirm squash and merge**, the second merges. A **Delete branch** checkbox replaces the second "Merge and delete branch" dialog. **Enable auto-merge** works the same way. The merge method is a page menu instead of a dropdown.
- While Claude works, the review page shows Clawd, Claude's pixel mascot, instead of a pulsing dot. Each time the page opens it picks one of four animations: a hop, a squash hop, a sideways scuttle or typing. With reduced motion on, Clawd stands still.
- While Claude runs, the review page header, a thread's live box and the Guide card show its last three steps like a Claude Code transcript: `Edit(src/retry.ts)` with Claude's latest sentence under the current step, and the exact result under finished ones, such as "Read 120 lines" or a failed command's last output line. The current step shows how long the run has taken. Clawd's animation no longer restarts when the status changes.
- Claude's avatar is Clawd on a clay-tinted circle on the review page. When Claude's reply replaces its live log, Clawd hops from the log up into the reply's avatar; with reduced motion on, the reply just appears.
- **Open in terminal** works while Claude runs. It reads **Stop and open in terminal**, stops the background run, and continues the conversation in the terminal; the comments Claude was answering wait for **Retry**.
- **Commit suggestion** works while Claude has unpushed commits. The suggestion becomes one more local commit after them, and **Push N commits** pushes them together. It failed with "The PR worktree has commits that are not on GitHub" before. A GitHub suggestion whose file the unpushed commits change still asks you to push first, since its lines may have moved.
- Claude writes `suggestion` blocks only for changes within the commented lines. Changes to other lines or files come as a `diff` block per file, so they no longer show up as a one-line **Commit suggestion**.
- **Ask Claude** and **Implement** stay disabled until the comment or reply has text.
- Avatars no longer reload and blink each time Claude updates a thread.
- Closing or cleaning up a PR stops its Claude even when the run was still starting, and kills a Claude that ignores the stop signal after 5 seconds. A Claude could keep running for hours after its worktree was removed before.
- The Pull Requests view has a **Pinned** section above Review requested and Mine. Pin a PR with the pin icon on its row, or drag it onto **Pinned**; drag pinned rows to reorder them. A pinned PR leaves its role section, stays pinned after it drops out of your review requests, and is unpinned once GitHub reports it merged or closed.
- A thread's header on the review page stays at the top while you scroll through a long thread, so you can collapse it from there. Collapsing keeps the header where it was on screen.
- Threads with more than four messages show only the latest three, with **Show N earlier messages** above them, which turns into **Hide N earlier messages** once shown.
- When VS Code has no GitHub sign-in for a host, Pair Review uses GitHub CLI's token for it (`gh auth token --hostname <host>`). GitHub Enterprise users signed in to `gh` no longer sign in again after each window reload.
- On your own PR, Claude answers Local threads in auto mode, so **Implement** can run tests, builds and git commands. Before, it could only edit files and refused every command.
- On someone else's PR, Claude also answers Local threads in auto mode, so it can run commands and try a change to test an idea. After each answer, Pair Review discards its edits and commits, unless the worktree already had uncommitted changes. Git hooks, and the checkout's `CLAUDE.md`, skills, hooks, settings and MCP servers, stay off. Commands that run tests or builds still run the PR author's code.
- Claude can read and search the workspace's other folders while answering a Local thread.
- On your own PR, Claude commits what it changes for a Local thread and does not push. The thread lists each commit with **Not pushed** until GitHub has it. The chevron before a commit unfolds its changes inside the thread; the hash shows the commit in the Files tab. **Push N commits** in the files bar pushes them, and **Show changes** next to it opens every commit GitHub does not have yet in the Files tab. The range menu lists those commits after the PR's, marked **Not pushed**, with a **Not pushed** entry that picks them all.
- **Open in terminal** on the review page replaces **Show log**. It continues the PR's Claude conversation in a VS Code terminal with the same tools and limits. It is off while Claude answers in the background; a comment sent while the terminal conversation is open still starts a background answer in the same conversation. The log stays available from Claude's error message.
- Before Claude answers a Local thread, the worktree moves to the PR's latest commit on GitHub, so commits pushed from another checkout are never edited over. Local commits built on that commit stay. If the worktree went another way, the run stops and says why; if GitHub can't be reached, Claude works on the worktree as it is. The review page shows the new files when the worktree moves.
- The review page sends half as many GitHub requests after an action, loads the Conversation card together with the rest of the page, and redraws faster with many read marks.
- Refreshing the review page redraws only the files whose changes differ, instead of every file.
- **Dismiss review** is offered for every reviewer GitHub lists. Reviews by people without write access were missing from the review page's list before.
- Replies to a GitHub thread on the review page offer **Ask Claude** and **Implement** next to **Post on GitHub**. Claude gets the thread's comments and your note, which may be empty, in a Local thread on the same lines; nothing reaches GitHub. That thread's **Reply on GitHub…** posts Claude's answer inside the colleague's thread after you edit it. Outdated GitHub threads can't be handed to Claude, since their lines no longer match the code.
- The review page has a **Conversation** card like GitHub's Conversation tab: comments on the PR, reviews with their summaries, pushed commits, force pushes, label, reviewer, assignee, title, base branch, milestone and merge events, and mentions from other issues. A box at the bottom posts a comment on the PR outside any review. The card folds from its heading, and on long PRs it shows the latest six entries with **Show N earlier entries** above them.
- GitHub comments in the Conversation card and in diff threads can be edited by their author, quoted into a reply, hidden for a reason such as Outdated or Spam, shown again, and deleted. Hidden comments fold to one line with **Show**. Comments, reviews and the description take GitHub's eight reactions.
- Text boxes that post to GitHub have **Write** and **Preview** tabs, rendered by GitHub, and complete `@` mentions from the repository's people and everyone on the PR.
- **Discard** drops your pending review. Reviewer rows offer **Re-request review** and, with write access, **Dismiss review** with a reason.
- The range menu next to the Files and Guide tabs lists the PR's commits with their checks, changed files and lines. Click one to see only its changes, Shift-click another for the commits between, or pick **Since your last review**. Commit hashes in the Conversation card open that commit's changes. A note above the files names the commit shown. Lines can take comments only where they match the PR's latest version, and read marks need all changes.
- The Files tab can hide whitespace changes, filter files by name, by file type and by Viewed, with **Clear filters** in the filter menu, and folds generated files and large diffs by default, with a chip saying why. Keyboard shortcuts: `j`/`k` next or previous file, `n`/`p` next or previous comment, `v` toggle Viewed, `t` filter files, `?` list them.
- Checks show which are required, re-run the failed jobs of a GitHub Actions workflow, approve workflows waiting on a fork PR, and place check annotations under the lines they point at.
- GitHub suggestions in review threads offer **Commit suggestion** and **Add to batch** on PRs you can push to. **Commit N suggestions** in the files bar commits the batch as one commit and pushes it.
- The Merge box lists review, check and branch protection status, offers **Update branch** by merge or rebase when the branch is behind, lets you edit the merge commit title and message before merging, enables and disables auto-merge, adds the PR to a merge queue and removes it, opens a revert PR after merging and restores a deleted head branch.
- The sidebar shows the milestone, with a picker, and the issues the PR closes. The pencil after the base branch opens a filterable branch menu, asks to confirm, and changes the base; the diff follows.
- **Search pull requests** in the Pull Requests view finds PRs assigned to you, mentioning you, all open ones, recently closed or merged ones, or any GitHub search, and opens the review page for the one you pick.
- The header's Open on GitHub, Refresh and Remove worktree links are icon buttons. Text fields on the page show a thin focus line instead of the wide focus ring.
- Projects are not shown. Reading them needs the `read:project` sign-in scope, which would make everyone sign in to GitHub again.

- Replies in a local thread on the review page offer **Implement** next to **Ask Claude**, like a new comment. Every reply reused the thread's first choice before, so a thread started with Ask could never ask Claude to change the code.
- The Reviewers, Assignees and Labels gear buttons on the review page open a popover under the gear, with a filter box and a checkmark on selected items, instead of VS Code's picker at the top of the window. Labels show as on GitHub: a color dot, the name, and the description below it. Label chips in the sidebar lose their dot. Changes save when you click outside the popover or the gear again; Esc closes it without saving. The filter matches names only.
- The review page shows the PR number as a chip before the title, like the branch chips; clicking it copies the link to the PR.
- Comment authors without a loadable avatar, as on GitHub Enterprise, show their initials: from their profile name, or the first letter of their login when they set no name.
- Guide steps can show the unchanged lines around their changes, with the same expand buttons as the Files tab. The buttons were missing before.
- Resolving a thread on the review page folds it. It stayed open before.
- The PR you merge from the review page shows as Merged in the Pull Requests sidebar right away, with a purple merge icon. GitHub's search keeps listing a merged PR as open for a while.
- The **+** next to a hovered line number is smaller and lines up with the number, also on lines that wrap.
- Once you expand lines above a hunk, the expand row shows how many lines are still hidden instead of the hunk's `@@` header, which no longer sat next to its lines.
- Diff hunks on the review page take their syntax colors from the whole file. A hunk that started inside a docstring, comment or multi-line string showed the following code in string colors before.
- Re-read GitHub state after PR management actions even when a write fails partway through, so saved reviewer requests and completed merges do not leave a stale review page. Report potentially saved requests when withdrawal fails.
- Reject PR management messages without edit permission, and correctly preselect users whose login matches a team display name.

- Comments and Claude's replies render Markdown tables, with column alignment and inline code. They showed as raw pipes before.
- Code suggestions on the review page. **Suggest change** in the comment box starts a GitHub-style suggestion from the selected lines. Suggestions in local threads show as a small diff with **Publish suggestion**, which adds it to your pending GitHub review so the author can commit it there, and a button that uses it right away. Both refuse once the commented code changed. Claude on a PR now proposes code as suggestions and can offer up to three options to switch between. Suggestions show in the file's syntax colors and line up with the comment text. On a PR you can push to, **Commit suggestion** commits the option to the PR branch as "Apply suggestion from code review" and pushes it, like GitHub; a failed push takes the commit back. On other PRs, **Apply** changes the worktree only and the card offers **Discard**. The diff reloads either way.
- Comments Claude is waiting on or working on show a pulsing line inside the thread with Claude's current step, such as "Reading src/app.ts". The Threads card shows the same step. Sending a reply redraws only that file instead of the whole review page.
- **Fix conflicts** in the Merge box, when GitHub reports conflicts on a PR you can push to. The PR's Claude merges the base branch in its own conversation, resolves the conflicts, commits and pushes. It may run only the Git commands this needs. The worktree must have no uncommitted changes or unpushed commits. On someone else's PR, Git hooks stay off while Claude works. While Claude works, the Merge box shows its current step, such as "Running git merge". On your own PR, the review box shows only Comment, since GitHub lets you only comment there; the Merge box buttons line up on the right. When Claude stops because a conflict needs your decision, the Merge box shows its question with an answer box; **Fix conflicts** there sends your answer to the same conversation and tries again.
- The review page previews changed images, SVGs and PDFs, before and after side by side. Images show their size on a checkerboard so transparency is visible; SVGs keep their Diff and Preview switch; PDFs show their first 10 pages. Files over 20 MB are not previewed. PDF previews load pdf.js the first time a page needs it, which adds about 1.6 MB to the extension.
- Markdown, HTML, SVG, image and PDF files have their Diff and Preview switch in the Guide too.
- Markdown previews show images the file links from the repository, such as `![Chart](assets/chart.png)`. They showed a broken image before.
- The review page's file list has two tabs: **Files** with the file count, and **Guide** with the step count, a pulsing dot while Claude builds it, and Build guide. Unified and Split are a separate diff style that works in both tabs, so guide steps can show side by side. Switching tabs also switches the Pull Requests sidebar between files and guide steps.
- Every border and divider on the review page uses the theme's input border color, so file boxes, comments, code blocks and cards stand apart from the page even in themes where the panel border is near black. Comments no longer show a collapse arrow; click the header to fold them.
- Drag the definition panel's left edge to make it wider or narrower. The page remembers the width; double-click the edge to reset it.
- Hovering a diff line shows a **+** next to its line number, as on GitHub. Click it to comment on the line, or drag over the numbers to comment on a range.
- Cmd or Ctrl-click on a name with no definition shows a short hint that clears itself after a few seconds, on the next click or on Escape, instead of an error that stayed until clicked. When VS Code has no language support for the file, the hint offers **Find extension**, which searches the Marketplace for that file type.
- Definitions in the same file are found without a language extension's answer. Pair Review first asks the file's symbols, then looks for a declaration of the name (`def`, `class`, `function`, `const` and similar). The definition panel marks such a match as "same name in this file".
- Filter the Pull Requests sidebar by author with the filter button in its title bar. The view's title shows the active author, and the filled filter icon clears it.
- PR rows in the sidebar list either their files or their guide steps, not both. The map and files buttons in the title bar switch between them; a PR without a guide always lists its files.
- PRs show their size and age. Sidebar rows end in lines added and removed, and their tooltip says when the PR was opened and last updated. The review page shows the same under the byline: Opened 3d ago · Updated 2h ago · +312 −48 in 14 files.
- PR worktrees moved from `.git/pair-review` to `.claude/worktrees/pair-review` in the repository, where Claude Code keeps its own. Claude refused to edit files under `.git` as sensitive, so implementing a comment in a PR worktree failed. Existing worktrees move on the next start, with their uncommitted changes, comments and review marks; Claude starts a new conversation for each. Git ignores the folder through `.git/info/exclude`, so `.gitignore` stays untouched.
- Pair Review removes PR worktrees when the PR is merged or closed, or when you have not opened it for 14 days (`pairReview.worktreeCleanupDays`). Worktrees with uncommitted changes or unpushed commits are kept. **Pair Review: Clean up worktrees** runs the check on demand.
- The Pull Requests sidebar lists PRs of a repository that was renamed or moved on GitHub while your clone's remote still uses the old name. It showed none before.
- The PR rows in the sidebar no longer show inline buttons. Open review page, Show Claude activity, Open in browser and Remove worktree moved to the row's right-click menu, and the review page has a Remove worktree link next to Refresh.
- Manage the PR from the review page: edit the title and description, request or withdraw reviewers (people and teams), set assignees and labels, mark a draft ready for review or turn the PR back into a draft, close and reopen it, and delete its branch when merging or afterwards. Reviewers, assignees and labels open a VS Code picker. These controls show only when GitHub lets you edit the PR.
- The review page shows the description, reviewers and checks again. GitHub refused that request because reading team reviewer names needs the `read:org` scope. Pair Review now asks for it, so VS Code asks you to sign in to GitHub once more.
- New look across Pair Review's webviews. One set of design tokens in `src/designTokens.ts` sets every color, font size, spacing step and corner radius. Surfaces, text and borders follow your VS Code theme. Your own actions (primary buttons, selections, review progress) use the theme's text color, so only Claude (clay) and GitHub (slate blue) carry a color. The pinned code selection in the editor is neutral too. Corners follow VS Code's modern UI.
- The review page shows the PR's branches as chips you click to copy. Claude's status is a chip that pulses while Claude works. Panel headings are sentence case. Approve is the last button in its row.
- Threads say who can see them with an icon and a word: **Local**, **On GitHub** or **Guide** (Claude's notes, shown in the Guided layout). The full sentence moved to the label's tooltip. Threads no longer have a thick colored left border.
- The new-comment box sends with one click: Implement asks Claude for a change, Ask Claude asks a question. The dropdown is gone. The main button always sits at the bottom right, after Cancel.
- The files bar uses VS Code icons for Unified, Split, Guided and Folders, collapse and expand all files, and one button that collapses or expands all comments. Hovering an icon button shows what it does. Folders stays in place in Guided, greyed out, so the toolbar no longer shifts when you switch layouts. While Claude builds the guide, a pulsing chip next to Build guide shows its progress.
- New icon for the activity bar and the Marketplace: a comment bubble split into a removed and an added half.
- Local Review is now Pair Review. The extension ID, settings (`pairReview.*`), commands, Claude plugin (`/pair-review:connect`) and PR worktree folder (`.git/pair-review`) use the new name. Settings, PR worktrees and PR handoff comments from Local Review are not carried over.
- On someone else's PR, Claude no longer loads the checkout's `CLAUDE.md`, skills, hooks, settings or MCP servers, for both the guide and answers to comments. The PR author controls those files. Your own user-level Claude setup still applies.
- Add your own instructions for the guide (`guide.md`) and for Claude's work on review comments, answers and changes (`comments.md`) in `.claude/pair-review/` folders: in Claude's config folder, parent folders of the project, the repository, or Claude's per-project folder. Claude gets them after the built-in instructions, most specific last. On someone else's PR, the repository's file is read from the base branch. See [Usage](docs/USAGE.md#your-own-instructions-for-claude).
- Guided review on the review page: click **Build guide** and Claude reads the PR read-only, groups its changes by severity (Critical, Significant, Routine, Trivial), orders them for reading and explains each step. The **Guided** layout shows each step as a slice of the diff with its note, a note on the file, and a line on how it follows from the step before. Each step note is a thread marked **Guide** that you can reply to. Every change lands in exactly one step; changes the guide missed, or whose code changed since, go under Unclassified. A step's **Viewed** marks its lines read, so once every step is Viewed, every file is. Trivial changes start folded. Rebuild guide replaces notes nobody replied to. Each step has a short title, and the Pull Requests sidebar lists the steps under the PR as **Guide**, grouped by severity with a check on viewed steps; clicking a step opens the review page at it. On the review page, groups and steps hang off rails like a threaded discussion: a round button on each header folds it, curved lines join each step to its group, and headers stay on screen while you scroll.
- **Folders** on the review page's toolbar groups files by folder in the Unified and Split layouts, with the same rails as Guided. It is off by default and remembered. Each folder shows how many of its files are viewed, folds from its button or its rail, and keeps its header on screen while you scroll. Folders in the PR sidebar no longer show an icon next to VS Code's own fold arrow.
- Thread cards on the review page match the comment box: an even border instead of a colored side bar, and every button on the right, with the GitHub link first and Reply last. The status shows as a small label only when it adds something, so Guide notes no longer say Answered.
- Comments on the review page show the avatar beside the text instead of a name line above it, and a relative time (5m ago, 2d ago) that updates by itself; hover it for the exact time. Local and Guide messages drop the You and Claude line, since the avatar says who wrote it: Claude's orange mark, and your GitHub avatar for you. Pending sits on the right in amber, as on GitHub.
- Code blocks in comments on the review page use your theme's colors right away. Before, they could fall back to the default colors until the language was used elsewhere.
- The activity bar icon fills its square like VS Code's own icons instead of looking smaller.
- Delete your own GitHub comments from the review page with the trash icon, after a confirmation. Deleting a thread's only comment removes the thread.
- The review page's Threads card groups threads into GitHub, Local and Guide, each foldable with a count, and shows one line per thread in aligned columns: file and line, the text with code formatted, and the status on the right when it adds something. Clicking anywhere on a row jumps to the thread. Guide starts folded, since its notes already sit in the diff.

- Opening the comment box, switching it between Claude and GitHub, replying and expanding context redraw only that file instead of the whole review page, so they stay fast on large PRs. The comment box separates its actions: the send button stands out, Cancel sits on the right, and the shortcut hint reads as keys.
- Mark lines read on the review page: select lines like for a comment, then tick **Viewed** in the comment box's header. Read lines collapse to one row you can open or unmark. Marking added lines also covers the lines they replace. A mark follows its code when other lines move and lapses once that code changes. When every change in a file is read, the file is marked Viewed. Viewed ticks and read marks made in quick succession all stick, and a ticked file no longer opens again.
- The PR sidebar and review page do less repeated work in folders with many repositories. Claude progress and ticking a file redraw only that PR's row, and a file's hash is computed again only after the file changes. Diff editors find a PR's worktree without rescanning the workspace folder, and read a base file's content once. The review page loads its details and GitHub threads in one request and colors large diffs without blocking other extensions. Git remotes and GitHub's Viewed flags are read once per Refresh.
- Pair Review no longer needs the GitHub CLI. The PR sidebar, review page and PR handoff sign in with your GitHub account in VS Code. When you are signed out, the Pull Requests view shows a **Sign in to GitHub** button (also **Pair Review: Sign in to GitHub** in the Command Palette), and PR handoff asks you to sign in. The sidebar reloads after sign-in. GitHub Enterprise works for the one host set in `github-enterprise.uri`.
- Clicking an element in an HTML preview to comment keeps the page where it is instead of jumping to the top of the file.
- The PR sidebar lists every Git repository inside the workspace folder, such as a folder of service repositories. Repositories without open PRs are left out. A repository whose PRs cannot be loaded shows its error on one row without hiding the others.
- The PR sidebar groups by role by default: Review requested and Mine on top, repositories under them. Switch to Group by repository in the view's ... menu. Role and repository rows have their own icons and PR counts.
- The PR sidebar loads much faster with many repositories: two GitHub searches list the PRs of every repository at once, instead of two `gh pr list` calls per repository, and repository names come from git remotes instead of `gh repo view`. The lists from the last load show right away while fresh ones load.
- The PR sidebar fills as soon as it opens: Pair Review starts when the view is shown, registers the view before its other setup, and finds nested repositories by scanning the workspace folder (honoring `git.repositoryScanMaxDepth` and `git.repositoryScanIgnoredFolders`) instead of waiting for the Git extension's scan.
- Choose repositories... in the PR sidebar's ... menu picks which repositories it lists, and Hide repository on a repository's right-click menu hides one. Hidden repositories are not queried, the choice is kept per workspace, and the view title shows how many are hidden.
- Support Node.js 20, the runtime SageMaker Code Editor uses for extensions and Claude hooks. Node.js 22 is no longer required.
- The PR overview became a review page: overview cards on top, every changed file below with syntax colors, a unified or split layout, a Viewed checkbox that collapses the file, and Open in editor for the native diff.
- Comment on the review page: click a line number, Shift-click to extend the range, and send a question or change request to Claude. Threads show inline under their lines with your messages, Claude's answers and status, plus Reply, Resolve and Publish to GitHub. Drafts survive redraws and reloads. Comments on lines the diff hides appear at the top of their file.
- The review page also shows GitHub comment threads from everyone, with Reply (posted on GitHub right away), Resolve and Open on GitHub. Each thread's header names its kind with its own mark: gray **Local**, terracotta **Analysis** with the Claude mark, or blue **GitHub**. Hover the name to see who can read the thread. A new comment or pending GitHub comment has a dashed border so a draft never looks like a posted thread.
- Comment straight on GitHub from the review page: switch the new-comment box from Claude to GitHub, then choose Add to review (pending until you submit the review) or Post now. GitHub only takes lines inside its diff, and the file must have no uncommitted changes.
- Clicking a PR or file in the sidebar opens the review page, scrolled to that file. The old all-files diff tab, its Viewed and unified/split buttons, and the proposed API they needed are gone.
- The review page has GitHub-style context: expand 20 lines up or down around each change, or Full file per file. Cmd/Ctrl-click a name to see its definition in a side panel, with Back, Open in editor and Escape to close.
- Claude's answers render as Markdown, GitHub comments as GitHub renders them. Pending GitHub comments are marked as only visible to you, and Post now is off while your review is in progress, since GitHub refuses single comments then.
- Code on the review page uses the same grammars and color theme as the editor, including grammars from installed language extensions and `editor.tokenColorCustomizations`. Files without an installed grammar, and a theme that is not plain JSON, fall back to the built-in colors.
- The definition panel shows up to 100 lines above and 400 below the definition to scroll through, marks the defined name, keeps strings and comments colored when the definition starts inside one, and has icon buttons for Back, Forward, Open in editor and Close.
- Holding Cmd or Ctrl on the review page underlines a name only when VS Code knows its definition.
- Added and removed lines on the review page line up with unchanged lines; the + or - sign no longer pushes the code to the right.
- GitHub comments show the author's profile picture and a Pending badge per comment, like GitHub. Code blocks in comments have their own background and border.
- Opening a PR no longer fails when its branch is checked out in another worktree. The review worktree now checks out the PR detached.
- Drag across line numbers to comment on several lines. Once you expand all hidden lines between two changes, the `@@` header between them goes away.
- Syntax colors for Swift, Go, Rust, Kotlin, Java, C, C++, C#, Objective-C, Ruby, PHP, Dart, Scala, SQL, HTML, XML, CSS, SCSS, Markdown, YAML and TOML.
- Markdown and HTML files get a Diff | Preview switch. In a Markdown preview, click a block to comment on its source lines, and threads show under their block. In an HTML preview, click an element to comment on its source lines. Its threads sit in a margin next to the element, which gets an outline. The file's own scripts stay off.
- The sidebar shows a PR's files as a folder tree, with single-folder chains folded into one row. The view's title bar switches between tree and list, like Source Control.
- Review page layout: description and threads on the left, reviewers, checks, finish review and merge in a right rail. The files toolbar has a Unified/Split toggle and Collapse/Expand for files and for comments.
- Open in editor on the review page opens that one file in VS Code's diff editor, and the button matches the Viewed checkbox size.
- The sidebar shows each PR's review state (Approved, Changes requested, Commented) as a colored icon and label. The overview shows it as a badge with reviewer names.
- On your own PRs, the overview shows Approve and Request changes disabled with the reason, instead of hiding them.
- The PR overview shows the description, reviewers, CI checks, a form to comment, approve or request changes, and a merge button.
- Comment threads show the Claude logo as avatar and label each message (Comment, Reply, Answer).
- Move the Review view out of Source Control into its own **Local Review** icon in the activity bar.
- Add a **Pull Requests** view that lists the repository's open PRs under **Mine** and **Review requested** through the existing `gh` login. Clicking a PR opens it in the browser for now.
- Expand a pull request in the sidebar to list its changed files. Clicking the PR or a file opens all of the PR's changes in one scrollable diff tab, scrolled to that file. Each PR is checked out into its own Git worktree in the background, and the diff compares against the point where the PR branched off its target. Diff headers show short `pr-<n>/<path>` names and mark added and deleted files like Git diffs. **Remove worktree** deletes a checkout and refuses while it has uncommitted changes.
- Comment inline on pull request diffs with `/a`, `/i` and `/r`. Each PR keeps its own comments and its own Claude conversation. PR comments show in the Review view with their PR number and return after a reload. The side composer is not available for PRs yet.
- Answer PR comments automatically: sending a comment starts Claude in the background in the PR's worktree with your `claude` login, and later comments resume the same conversation. Thread labels, the sidebar and the status bar show Claude's current step, such as "Reading src/app.ts". **Show Claude activity** on a PR opens the full log and sends failed or skipped comments again. On someone else's PR, Claude cannot edit files or run commands and proposes changes as diffs.
- Start a PR's Claude through your login shell, so your own `claude` setup (such as per-folder accounts) applies, and keep PR worktrees in the repository's `.git/local-review` folder. When a run fails, the thread says why (for example "Claude failed · Not logged in") and a notification offers Retry and the log. Thread labels also show "Thinking" and "Writing".
- Fix PR diff tabs restored after a reload showing "Resource not found": VS Code now starts Local Review as soon as it needs a PR file.
- Tick files as reviewed in a checked-out PR's file list. The PR row shows progress, such as "1/3 reviewed". Ticks sync both ways with GitHub's per-file "Viewed" checkbox, and a local tick clears itself when the file changes afterwards.
- Show PR files like Source Control: file-type icons and colored A, M, D and R letters.
- Publish a PR thread to GitHub from its thread or Review view action. An editable preview starts from Claude's last answer; post it into your pending review or as a comment right away. Comments outside the PR diff go on the whole file. Published threads show "On GitHub" and link to the comment.
- Add a PR overview tab, opened from the PR row: reviewed progress, Claude's current step with its log and retry, and every thread with its status and GitHub link.
- Leave untracked files out of PR diffs, so files tools create in a worktree (such as `.ui-review/`) no longer show up as PR changes.
- Add the `localReview.mockPullRequests` setting, which fills the Pull Requests view with sample data for testing.
- Let Git change listing compare against an explicit base commit, preparing PR review. Local review still compares against `HEAD`.

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
