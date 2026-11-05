import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { createReviewBridge } from './bridge.js';
import { createReviewStore } from './store.js';
import { prepareConnection, registerClaudeLauncher } from './setup.js';
import { GitHubApiProvider } from './pullRequests.js';
import { signInToGitHub, watchGitHubSessions } from './githubApi.js';
import { mockPullRequestProvider } from './mockPullRequests.js';
import { commitAndPush, commitFiles, conflictTask, prepareConflictFix, pushCommits, syncKeepingLocalCommits, syncToPullRequestHead, unpushedCommits } from './conflicts.js';
import { registerPullRequestView, type PullRequestWorktrees } from './pullRequestView.js';
import { cleanUpWorktrees } from './worktreeCleanup.js';
import { sharedPerTurn } from './autoSync.js';
import { type PullRequestRole, ensureWorktree, git, hasWorktree, readPullRequestBase, removeWorktree, reviewDataPath, worktreePath } from './worktrees.js';
import { buildGuide, groupReadMarks, guideOutline } from './prAnalysis.js';
import { readSavedAnalysis } from './prAnalysisRunner.js';
import { highlightSource, readPlainPullRequestDiff, readPullRequestDiff, savedCodeDiff, type FileDiff } from './unifiedDiff.js';
import { fenceFilePaths, markdownHtml } from './markdown.js';
import { readFilePreview, readMediaSides } from './fileContent.js';
import { DefinitionPeeks } from './definitions.js';
import { FileReviews } from './reviewedFiles.js';
import { saveSelection } from './pullRequestEdits.js';
import { buildOverviewState, revealOpenPage, showPullRequestOverview, type AnalysisView, type AppliedSuggestion, type DiffSelection, type FilesView, type OverviewReveal, type PageComment } from './pullRequestOverview.js';
import type { PullRequestConversation, PullRequestDetails, PullRequestProvider, PullRequestSummary, PullRequestVersion, RemoteThread } from './pullRequests.js';
import { githubPageActions } from './pullRequestPageActions.js';
import { openPullRequestFile, parsePullRequestFileUri, readBaseContent, registerPullRequestDiffs } from './pullRequestDiff.js';
import { PullRequestSessions, type PullRequestSession } from './pullRequestSessions.js';
import { Checkouts, nestedRepositoryRoots, type Checkout } from './checkouts.js';
import { claudeStatus } from './claudeStatus.js';
import { isWorkspaceRelativePath, readGitBase } from './git.js';
import { applySuggestion, parseSuggestions, suggestionLines, suggestionMarkdown } from './suggestions.js';
import { mediaType } from './media.js';
import { anchorFromText } from './anchors.js';
import { prepareHighlighting, useEditorHighlighter } from './codePreview.js';
import { editorHighlighter } from './textMate.js';
import { githubFeedbackRequest, placeComment } from './pullRequestComments.js';
import type { CodeAnchor, ReviewBridge, ReviewStore, ReviewThread } from './contracts.js';
import { readFileIcons } from './fileIcons.js';
import { LocalReview, toDisposable, wholeFile } from './localReview.js';
import { LocalFilesView } from './localFilesView.js';

let activeStore: ReviewStore | undefined;
let activeBridge: ReviewBridge | undefined;
let activePullRequests: Checkouts | undefined;

/** Initialize one workspace-scoped review and its private local connection. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined || folder.uri.scheme !== 'file' || !vscode.workspace.isTrusted) return;
  const root = folder.uri.fsPath;
  let themeLoads = 0;
  const loadHighlighter = (): void => {
    const load = ++themeLoads;
    void editorHighlighter(context.asAbsolutePath(join('dist', 'onig.wasm'))).catch(() => undefined).then((highlighter) => {
      if (load === themeLoads) useEditorHighlighter(highlighter);
    });
  };
  loadHighlighter();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(loadHighlighter),
    vscode.extensions.onDidChange(loadHighlighter),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('editor.tokenColorCustomizations') || event.affectsConfiguration('workbench.colorTheme')) loadHighlighter();
    }),
  );
  const mockPullRequests = (): boolean => vscode.workspace.getConfiguration('pairReview').get('mockPullRequests', false);
  const checkouts = new Checkouts(root, context.globalStorageUri.fsPath, {
    discover: async () => mockPullRequests() ? [] : await nestedRepositoryRoots(root),
    create: (checkoutRoot, storageRoot) => {
      const connect = async (): Promise<PullRequestProvider> => mockPullRequests() ? mockPullRequestProvider : await GitHubApiProvider.connect(checkoutRoot);
      return { root: checkoutRoot, storageRoot, connect, sessions: new PullRequestSessions(context, storageRoot, checkoutRoot, connect), fileReviews: new FileReviews(storageRoot) };
    },
    onRestoreError: (error) => {
      void vscode.window.showErrorMessage(`Pair Review could not restore pull request reviews: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  context.subscriptions.push(checkouts, registerPullRequestDiffs(async (repository, number) => (await checkouts.locate(repository, number))?.storageRoot));
  const storage = context.storageUri;
  if (storage === undefined) return;
  try {
    await mkdir(storage.fsPath, { recursive: true, mode: 0o700 });
    const store = await createReviewStore(join(storage.fsPath, 'review.json'), folder.uri.fsPath);
    activeStore = store;
    activePullRequests = checkouts;
    const showOverview = async (checkout: Checkout, provider: PullRequestProvider, repository: string, pullRequest: PullRequestSummary, role: PullRequestRole, reveal?: OverviewReveal): Promise<void> => {
      const { storageRoot, sessions: pullRequestSessions, fileReviews } = checkout;
      await ensureWorktree(checkout.root, storageRoot, provider, repository, pullRequest, role);
      const opened = await pullRequestSessions.open(repository, pullRequest.number);
      const folder = worktreePath(storageRoot, repository, pullRequest.number);
      const listed = provider.listFiles(pullRequest.number).then((files) => files.map((file) => file.path), () => undefined);
      let diffPaths: readonly string[] = [];
      /** Changed files from the latest diff read, so media previews need no second read. */
      let diffFiles: readonly FileDiff[] = [];
      const definitions = new DefinitionPeeks(folder);
      /** The base branch, which the page can change. */
      let baseBranch = pullRequest.baseBranch;
      const current = (): PullRequestSummary => ({ ...pullRequest, baseBranch });
      const readBase = async (): Promise<string> => {
        const base = await readPullRequestBase(folder, baseBranch);
        if (base === undefined) throw new Error(`Could not find where #${pullRequest.number} branched off ${baseBranch}.`);
        return base;
      };
      /** What the Files tab shows; comments and read marks need the whole PR at its latest version. */
      let selection: DiffSelection = { range: { kind: 'all' }, whitespace: false };
      let selectionAtHead = true;
      const findThread = (id: string): ReviewThread => {
        const thread = opened.session.store.threads.find((candidate) => candidate.id === id);
        if (thread === undefined) throw new Error('This thread no longer exists.');
        return thread;
      };
      const pageAnchor = async ({ path, side, startLine, endLine }: Omit<PageComment, 'text' | 'intent'>): Promise<{ anchor: CodeAnchor; base: string }> => {
        if (!diffPaths.includes(path)) throw new Error(`${path} is not part of this PR's changes.`);
        if (!selectionAtHead || (side === 'old' && selection.range.kind !== 'all')) throw new Error('Show all changes to comment on these lines.');
        const base = await readBase();
        const content = side === 'old' ? await readBaseContent(folder, path, base) : await readFile(join(folder, path), 'utf8');
        const anchor = anchorFromText(content, { path, startLine, endLine, side: side === 'old' ? 'original' : 'working', baseRevision: base });
        return { anchor, base };
      };
      const readHead = async (): Promise<string> => (await git(folder, ['rev-parse', 'HEAD'])).trim();
      /** The PR on GitHub at the last check, so the next one can ask whether it changed. */
      let version: PullRequestVersion | undefined;
      /** The worktree commit the page's files were last sent for, so a move by Claude's run or a sync shows up. */
      let shownHead: string | undefined;
      /** A commit the diff needs, fetched when a force push left it out of the worktree. */
      const haveCommit = async (oid: string): Promise<void> => {
        if (await git(folder, ['cat-file', '-e', `${oid}^{commit}`]).then(() => true, () => false)) return;
        await git(folder, ['fetch', '--quiet', 'origin', oid]).catch(() => { throw new Error('That commit is no longer on GitHub, probably after a force push.'); });
      };
      /** Files opened for resolved Local threads outside the diff; files with open Local threads show without being opened. */
      const revealed = new Set<string>();
      /** Files outside the diff with Local threads, shown whole in tabs, or as their saved code once the file is gone. */
      const threadFiles = async (shown: readonly string[]): Promise<FileDiff[]> => {
        const threads = opened.session.store.threads;
        const paths = [...new Set([...threads.filter((thread) => !thread.resolved).map((thread) => thread.anchor.path), ...revealed])]
          .filter((path) => isWorkspaceRelativePath(path) && !shown.includes(path));
        await prepareHighlighting(paths);
        return Promise.all(paths.map(async (path) => await wholeFile(folder, path, 'unchanged')
          ?? savedCodeDiff(path, threads.filter((thread) => thread.anchor.path === path).map((thread) => thread.anchor))));
      };
      const readFiles = async (select?: DiffSelection): Promise<FilesView> => {
        const wanted = select ?? selection;
        const { range } = wanted;
        let base: string;
        let to: string | undefined;
        if (range.kind === 'all') base = await readBase();
        else if (range.kind === 'since') {
          const since = (await currentConversation()).lastReviewedCommit;
          if (since === undefined) throw new Error('You have not reviewed this PR yet.');
          await haveCommit(since);
          base = since;
        } else {
          await haveCommit(range.from);
          await haveCommit(range.to);
          base = (await git(folder, ['rev-parse', `${range.from}^`])).trim();
          to = range.to === await readHead() ? undefined : range.to;
        }
        const files = await readPullRequestDiff(folder, base, { ...to === undefined ? {} : { to }, ignoreWhitespace: wanted.whitespace });
        selection = wanted;
        selectionAtHead = to === undefined;
        diffPaths = files.map((file) => file.path);
        diffFiles = files;
        const tabs = range.kind === 'all' ? await threadFiles(diffPaths) : [];
        const icons = tabs.length === 0 ? undefined : await readFileIcons(tabs.map((file) => file.path)).catch(() => undefined);
        return { files: [...files, ...tabs], selection, atHead: selectionAtHead, ...icons === undefined ? {} : { icons } };
      };
      const readAnalysis = async (): Promise<AnalysisView> => {
        const result = await opened.analysis.result();
        const { running, step, progress, error } = opened.analysis.activity;
        const stale = result !== undefined && result.head !== await readHead().catch(() => result.head);
        return {
          running, stale, ...(step === undefined ? {} : { step }), ...(progress === undefined ? {} : { progress }),
          ...(error === undefined ? {} : { error }), ...(result === undefined ? {} : { result }),
        };
      };
      const detailsChanged = new vscode.EventEmitter<void>();
      let details: Promise<PullRequestDetails | Error> | undefined;
      const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
      const currentDetails = async (): Promise<PullRequestDetails> => {
        const loaded = await (details ?? loadDetails());
        if (loaded instanceof Error) throw loaded;
        return loaded;
      };
      /** Reload the page's details and the sidebar after a change it lists, such as title, draft or open state. */
      const changedOnGitHub = (): void => {
        void loadDetails();
        void loadConversation();
        void vscode.commands.executeCommand('pairReview.refreshPullRequests');
      };
      const loadDetails = sharedPerTurn((): Promise<PullRequestDetails | Error> => {
        details = provider.details(pullRequest.number).catch(asError);
        void details.then(() => { detailsChanged.fire(); });
        return details;
      });
      let remote: Promise<readonly RemoteThread[] | Error> | undefined;
      let conversation: Promise<PullRequestConversation | Error> | undefined;
      const loadConversation = sharedPerTurn((): Promise<PullRequestConversation | Error> => {
        conversation = provider.conversation(pullRequest.number).catch(asError);
        void conversation.then(() => { detailsChanged.fire(); });
        return conversation;
      });
      const currentConversation = async (): Promise<PullRequestConversation> => {
        const loaded = await (conversation ?? loadConversation());
        if (loaded instanceof Error) throw loaded;
        return loaded;
      };
      /** What Claude asked when it last stopped fixing conflicts without pushing. */
      let conflictQuestion: string | undefined;
      /** Suggestion options written to the worktree while this page is open, by thread. */
      const applied = new Map<string, AppliedSuggestion>();
      /** File contents around each suggestion applied without committing, so Discard can put the file back. */
      const undo = new Map<string, { readonly path: string; readonly before: string; readonly after: string }>();
      /** Where to push the PR's branch: `origin`, or the fork's URL when the branch lives in a fork. */
      const pushTarget = (loaded: PullRequestDetails): string => loaded.headRepository === undefined ? 'origin' : `https://${new URL(pullRequest.url).host}/${loaded.headRepository}.git`;
      const loadThreads = sharedPerTurn((): Promise<readonly RemoteThread[] | Error> => {
        remote = provider.threads(pullRequest.number).catch(asError);
        void remote.then(() => { detailsChanged.fire(); });
        return remote;
      });
      /** Details and threads in one request on first load; a failed combined request falls back to separate ones. */
      const loadOverview = (): void => {
        const both = provider.overview(pullRequest.number);
        details = both.then(({ details: loaded }) => loaded, () => provider.details(pullRequest.number)).catch(asError);
        remote = both.then(({ threads }) => threads, () => provider.threads(pullRequest.number)).catch(asError);
        void details.then(() => { detailsChanged.fire(); });
        void remote.then(() => { detailsChanged.fire(); });
      };
      const read = async (): Promise<ReturnType<typeof buildOverviewState>> => {
        if (details === undefined && remote === undefined) loadOverview();
        if (conversation === undefined) void loadConversation();
        const paths = await listed;
        const all = [...new Set([...(paths ?? []), ...diffPaths])];
        const [viewed, read] = await Promise.all([
          fileReviews.reviewed(provider, repository, pullRequest.number, all),
          readBase().then((base) => fileReviews.readRanges(repository, pullRequest.number, base)).catch(() => []),
        ]);
        const [loadedDetails, loadedThreads, analysis, loadedConversation] = await Promise.all([details ?? loadDetails(), remote ?? loadThreads(), readAnalysis(), conversation ?? loadConversation()]);
        await prepareHighlighting(opened.session.store.threads.flatMap((thread) => [thread.anchor.path, ...thread.messages.flatMap((entry) => fenceFilePaths(entry.text))]));
        const state = buildOverviewState(current(), opened, [...viewed], read, paths?.length, loadedDetails, loadedThreads, analysis, loadedConversation);
        const threads = state.threads.map((thread) => { const done = applied.get(thread.id); return done === undefined ? thread : { ...thread, applied: done }; });
        const unpushed = loadedConversation instanceof Error ? [] : await unpushedCommits(folder, loadedConversation.merge.headOid);
        return { ...state, threads, ...(conflictQuestion === undefined ? {} : { conflictQuestion: markdownHtml(conflictQuestion) }), ...(unpushed.length === 0 ? {} : { unpushed }) };
      };
      const changed: vscode.Event<unknown> = (listener) => vscode.Disposable.from(
        pullRequestSessions.onDidChangeState((changedSession) => { if (changedSession === opened) listener(changedSession); }),
        fileReviews.onDidChange((changed) => { if (changed === `${repository}#${pullRequest.number}`) listener(changed); }),
        detailsChanged.event(listener),
      );
      await showPullRequestOverview(`${repository}#${pullRequest.number}`, read, changed, {
        readFiles,
        readContext: async (path) => {
          if (!diffPaths.includes(path)) throw new Error(`${path} is not part of this PR's changes.`);
          const text = await readFile(join(folder, path), 'utf8');
          await prepareHighlighting([path]);
          return highlightSource(text, path);
        },
        readPreview: async (path) => {
          if (!diffPaths.includes(path)) throw new Error(`${path} is not part of this PR's changes.`);
          return readFilePreview(folder, path);
        },
        readMedia: async (path) => {
          const file = diffFiles.find((each) => each.path === path);
          if (file === undefined || mediaType(path) === undefined) throw new Error(`${path} is not an image or PDF in this PR's changes.`);
          return readMediaSides(folder, file, await readBase());
        },
        findDefinition: async (at, line, column) => {
          if ('peek' in at) return definitions.find(definitions.location(at.peek).uri, line, column);
          if (!diffPaths.includes(at.path)) throw new Error(`${at.path} is not part of this PR's changes.`);
          return definitions.find(vscode.Uri.file(join(folder, at.path)), line, column);
        },
        hasDefinition: async (at, line, column) => {
          if ('peek' in at) return definitions.has(definitions.location(at.peek).uri, line, column);
          if (!diffPaths.includes(at.path)) return false;
          return definitions.has(vscode.Uri.file(join(folder, at.path)), line, column);
        },
        missingLanguage: async (at) => {
          if ('peek' in at) return definitions.missingLanguage(definitions.location(at.peek).uri);
          return diffPaths.includes(at.path) ? definitions.missingLanguage(vscode.Uri.file(join(folder, at.path))) : undefined;
        },
        openDefinition: async (peek) => {
          const { uri, range } = definitions.location(peek);
          await vscode.window.showTextDocument(uri, { selection: range, preview: true });
        },
        comment: async ({ text, intent, ...lines }) => {
          const { anchor } = await pageAnchor(lines);
          await opened.session.store.submit(anchor, text, intent);
        },
        reply: async (id, text, intent) => {
          const thread = findThread(id);
          if (thread.resolved) throw new Error('Reopen this thread before replying.');
          await opened.session.store.submit(thread.anchor, text, intent, id);
        },
        resolve: (id, resolved) => opened.session.store.resolve(findThread(id).id, resolved),
        publish: async (id) => { await opened.session.publish?.(findThread(id).id); },
        postToGitHub: async (id, text, pending) => { await opened.session.postToGitHub?.(findThread(id).id, text, pending); },
        commentOnGitHub: async ({ text, ...lines }, pending) => {
          const { anchor, base } = await pageAnchor(lines);
          const placement = await placeComment(folder, base, anchor);
          if (placement.lines === undefined) throw new Error('GitHub only takes comments on lines its diff shows. Pick lines inside a changed section.');
          await provider.publishComment(pullRequest.number, { ...placement, body: text }, pending);
          await Promise.all([loadThreads(), loadDetails()]);
        },
        replyOnGitHub: async (id, text) => {
          await provider.replyToThread(id, text);
          await loadThreads();
        },
        askAboutGitHub: async (id, note, intent) => {
          const loaded = await (remote ?? loadThreads());
          const thread = loaded instanceof Error ? undefined : loaded.find((each) => each.id === id);
          if (thread === undefined) throw new Error('This GitHub thread no longer exists.');
          if (thread.outdated) throw new Error('The code changed since this comment, so Claude would read the wrong lines. Comment on the current lines instead.');
          const { anchor } = await pageAnchor({ path: thread.path, side: thread.side === 'LEFT' ? 'old' : 'new', startLine: thread.startLine, endLine: thread.endLine });
          const comments = thread.comments.filter((comment) => comment.hidden === undefined);
          const created = await opened.session.store.submit(anchor, githubFeedbackRequest(note, intent, comments), intent);
          await opened.session.linkToGitHub?.(created.id, { id: thread.id, url: thread.url });
        },
        resolveOnGitHub: async (id, resolved) => {
          await provider.resolveThread(id, resolved);
          await loadThreads();
        },
        deleteOnGitHub: async (id) => {
          await provider.deleteComment(id);
          await Promise.all([loadThreads(), loadDetails()]);
        },
        setViewed: (path, viewed) => fileReviews.set(provider, repository, pullRequest.number, path, viewed),
        markRead: async (range, fileDone) => {
          if (!diffPaths.includes(range.path)) throw new Error(`${range.path} is not part of this PR's changes.`);
          if (selection.range.kind !== 'all') throw new Error('Show all changes to mark lines read.');
          await fileReviews.markRead(repository, pullRequest.number, await readBase(), range);
          if (fileDone) await fileReviews.set(provider, repository, pullRequest.number, range.path, true);
        },
        unmarkRead: (ids) => fileReviews.unmarkRead(repository, pullRequest.number, ids),
        openInEditor: (path) => openPullRequestFile(storageRoot, repository, current(), path),
        openTerminal: async () => {
          await opened.runner.stop();
          const { command, args, cwd, env } = await opened.runner.launch();
          vscode.window.createTerminal({ name: `Claude · #${pullRequest.number}`, shellPath: command, shellArgs: [...args], cwd, env }).show();
        },
        readCommit: async (oid) => {
          await haveCommit(oid);
          return readPullRequestDiff(folder, (await git(folder, ['rev-parse', `${oid}^`])).trim(), { to: oid });
        },
        push: async () => {
          if (opened.runner.activity.running) throw new Error('Claude is working on this PR. Push when it is done.');
          const loaded = await currentDetails();
          if (!loaded.canEdit) throw new Error('You cannot push to this PR.');
          await pushCommits(folder, { pushTo: pushTarget(loaded), headBranch: pullRequest.headBranch, hooksOff: role === 'reviewer' });
          changedOnGitHub();
        },
        retry: () => { opened.runner.retry(); },
        revealThread: async (id) => {
          const { path } = findThread(id).anchor;
          if (selection.range.kind !== 'all') { await openPullRequestFile(storageRoot, repository, current(), path); return; }
          revealed.add(path);
          revealOpenPage(`${repository}#${pullRequest.number}`, { path, reload: true });
        },
        closeFile: async (path) => { revealed.delete(path); },
        submitReview: async (event, body) => {
          await provider.submitReview(pullRequest.number, event, body);
          void loadDetails();
        },
        applySuggestion: async (id, message, option) => {
          const { anchor, messages } = findThread(id);
          const suggestion = parseSuggestions(messages[message]?.text ?? '')[option];
          if (suggestion === undefined) throw new Error('This suggestion no longer exists.');
          if (anchor.side !== 'working') throw new Error('Suggestions apply only to the PR\'s version of a file.');
          if (opened.runner.activity.running) throw new Error('Claude is working on this PR. Apply the suggestion when it is done.');
          const loaded = await currentDetails();
          const file = join(folder, anchor.path);
          let ahead = false;
          if (loaded.canEdit) {
            if ((await git(folder, ['status', '--porcelain', '--', anchor.path])).trim() !== '') throw new Error(`${anchor.path} has uncommitted changes. Commit or discard them first.`);
            ({ ahead } = await syncKeepingLocalCommits(folder, pullRequest.number));
          }
          const before = await readFile(file, 'utf8');
          const after = applySuggestion(before, anchor, suggestion);
          await writeFile(file, after);
          const commit = { path: anchor.path, message: 'Apply suggestion from code review', hooksOff: role === 'reviewer' };
          if (!loaded.canEdit) undo.set(id, { path: anchor.path, before, after });
          else if (ahead) await commitFiles(folder, commit);
          else {
            await commitAndPush(folder, { ...commit, pushTo: pushTarget(loaded), headBranch: pullRequest.headBranch });
            changedOnGitHub();
          }
          applied.set(id, { message, option, done: !loaded.canEdit ? 'applied' : ahead ? 'committed' : 'pushed' });
          detailsChanged.fire();
        },
        discardSuggestion: async (id) => {
          const change = undo.get(id);
          if (change === undefined) throw new Error('There is no applied suggestion to discard.');
          const file = join(folder, change.path);
          if (await readFile(file, 'utf8') !== change.after) throw new Error(`${change.path} changed since the suggestion was applied, so it was not discarded.`);
          await writeFile(file, change.before);
          undo.delete(id);
          applied.delete(id);
          detailsChanged.fire();
        },
        publishSuggestion: async (id, message, option) => {
          const { anchor, messages } = findThread(id);
          const suggestion = parseSuggestions(messages[message]?.text ?? '')[option];
          if (suggestion === undefined) throw new Error('This suggestion no longer exists.');
          if (anchor.side !== 'working') throw new Error('GitHub takes suggestions only on the PR\'s version of a file.');
          const head = await readHead();
          const lines = suggestionLines(await readGitBase(folder, anchor.path, head), anchor);
          await provider.publishComment(pullRequest.number, { path: anchor.path, body: suggestionMarkdown(suggestion), commitId: head, side: 'RIGHT', lines }, true);
          void loadThreads();
          void loadDetails();
        },
        fixConflicts: async (answer) => {
          const loaded = await currentDetails();
          if (loaded.mergeable !== 'no' || !loaded.canEdit) throw new Error('GitHub reports no conflicts you can fix on this PR.');
          const base = await prepareConflictFix(folder, pullRequest.number, baseBranch);
          const head = (await git(folder, ['rev-parse', 'HEAD'])).trim();
          conflictQuestion = undefined;
          const pushTo = pushTarget(loaded);
          const { error, reply } = await opened.runner.runTask(conflictTask({ base, baseBranch, headBranch: pullRequest.headBranch, pushTo, ...(answer === undefined ? {} : { answer }) }));
          const pushedNothing = (await git(folder, ['rev-parse', 'HEAD'])).trim() === head;
          if (error === undefined && pushedNothing && reply !== undefined) conflictQuestion = reply;
          changedOnGitHub();
          if (error !== undefined) throw new Error(`Claude did not fix the conflicts: ${error}`);
        },
        dismissConflictQuestion: () => {
          conflictQuestion = undefined;
          detailsChanged.fire();
        },
        merge: async (method, message, deleteBranch) => {
          const { branchDeletable } = await currentDetails();
          try {
            await provider.merge(pullRequest.number, method, message);
            await vscode.commands.executeCommand('pairReview.markPullRequestMerged', `${repository}#${pullRequest.number}`);
            if (deleteBranch && branchDeletable) await provider.deleteBranch(pullRequest.headBranch);
          } finally {
            changedOnGitHub();
          }
        },
        editTitle: async (next) => {
          const { title } = await currentDetails();
          if (next === title) return;
          await provider.editPullRequest(pullRequest.number, { title: next });
          changedOnGitHub();
        },
        editBody: async (body) => {
          await provider.editPullRequest(pullRequest.number, { body });
          void loadDetails();
        },
        pickerOptions: () => provider.pickerOptions(),
        pick: async (what, picked) => {
          await saveSelection(provider, pullRequest.number, await currentDetails(), what, picked);
          void loadDetails();
        },
        setDraft: async (draft) => {
          await provider.setDraft(pullRequest.number, draft);
          changedOnGitHub();
        },
        setOpen: async (open) => {
          await provider.editPullRequest(pullRequest.number, { state: open ? 'open' : 'closed' });
          changedOnGitHub();
        },
        deleteBranch: async () => {
          await provider.deleteBranch(pullRequest.headBranch);
          void loadDetails();
        },
        removeWorktree: async () => {
          await pullRequestSessions.close(repository, pullRequest.number);
          await removeWorktree(checkout.root, storageRoot, repository, pullRequest.number);
          void vscode.commands.executeCommand('pairReview.refreshPullRequests');
        },
        refresh: () => { void loadDetails(); void loadThreads(); void loadConversation(); },
        pollGitHub: async () => {
          const previous = version;
          version = await provider.version(pullRequest.number, previous);
          const reload = previous !== undefined && version !== previous;
          if (opened.runner.activity.running) return { reload, files: false };
          const before = await readHead();
          shownHead ??= before;
          let problem: string | undefined;
          const ahead = await git(folder, ['merge-base', '--is-ancestor', version.head, 'HEAD']).then(() => true, () => false);
          if (version.head !== before && !ahead) {
            await syncToPullRequestHead(folder, pullRequest.number, previous?.head).catch((error: unknown) => { problem = error instanceof Error ? error.message : String(error); });
          }
          const head = await readHead();
          const files = head !== shownHead;
          shownHead = head;
          return { reload: reload || files, files, ...(problem === undefined ? {} : { problem }) };
        },
        ...githubPageActions({
          provider, number: pullRequest.number, headBranch: pullRequest.headBranch, baseBranch: () => baseBranch, folder, hooksOff: role === 'reviewer',
          details: currentDetails, conversation: currentConversation,
          threads: async () => { const loaded = await loadThreads(); if (loaded instanceof Error) throw loaded; return loaded; },
          pushTarget, claudeBusy: () => opened.runner.activity.running,
          reload: (listed) => { if (listed === true) changedOnGitHub(); else { void loadDetails(); void loadConversation(); } void loadThreads(); },
          useBase: async (branch) => {
            await git(folder, ['fetch', '--quiet', 'origin', branch]).catch(() => undefined);
            baseBranch = branch;
          },
        }),
        analyze: async () => {
          const [files, head] = await Promise.all([readPullRequestDiff(folder, await readBase()), readHead()]);
          opened.analysis.start({
            files, head,
            about: `#${pullRequest.number} ${pullRequest.title} (${pullRequest.headBranch} into ${pullRequest.baseBranch})`,
            anchor: async ({ range }) => (await pageAnchor({ ...range, endLine: Math.min(range.endLine, range.startLine + 49) })).anchor,
          });
        },
        stopAnalysis: () => { opened.analysis.stop(); },
      }, context.extensionUri, reveal);
    };
    const worktreesOf = (checkout: Checkout): PullRequestWorktrees => {
      const { root: checkoutRoot, storageRoot, sessions, fileReviews } = checkout;
      /** A checked-out PR's guide with its diff and review marks, or undefined before it is analyzed. */
      const loadGuide = async (provider: PullRequestProvider, repository: string, pullRequest: PullRequestSummary) => {
        const folder = worktreePath(storageRoot, repository, pullRequest.number);
        const analysis = await readSavedAnalysis(reviewDataPath(folder));
        const base = analysis === undefined ? undefined : await readPullRequestBase(folder, pullRequest.baseBranch);
        if (analysis === undefined || base === undefined) return undefined;
        const files = await readPlainPullRequestDiff(folder, base);
        const [read, viewed] = await Promise.all([
          fileReviews.readRanges(repository, pullRequest.number, base),
          fileReviews.reviewed(provider, repository, pullRequest.number, files.map((file) => file.path)),
        ]);
        return { groups: buildGuide(analysis, files), files, read, viewed, base };
      };
      return {
        exists: (repository, number) => hasWorktree(storageRoot, repository, number),
        open: (provider, repository, pullRequest, role, revealPath) => showOverview(checkout, provider, repository, pullRequest, role, revealPath === undefined ? undefined : { path: revealPath }),
        showClaude: async (provider, repository, pullRequest, role) => {
          await ensureWorktree(checkoutRoot, storageRoot, provider, repository, pullRequest, role);
          showClaude(await sessions.open(repository, pullRequest.number));
        },
        remove: async (repository, number) => {
          await sessions.close(repository, number);
          await removeWorktree(checkoutRoot, storageRoot, repository, number);
        },
        claudeStatus: (repository, number) => {
          const opened = sessions.get(repository, number);
          return opened === undefined ? undefined : claudeStatus(opened.runner.activity).text;
        },
        reviewedFiles: (provider, repository, number, paths) => fileReviews.reviewed(provider, repository, number, paths),
        setReviewed: (provider, repository, number, path, reviewed) => fileReviews.set(provider, repository, number, path, reviewed),
        forget: () => { fileReviews.forget(); GitHubApiProvider.forget(); checkouts.rescan(); },
        showOverview: (provider, repository, pullRequest, role, at) => showOverview(checkout, provider, repository, pullRequest, role, at),
        guide: async (provider, repository, pullRequest) => {
          const loaded = await loadGuide(provider, repository, pullRequest);
          return loaded === undefined ? undefined : guideOutline(loaded.groups, loaded.files, loaded.read, loaded.viewed);
        },
        markGuideGroupRead: async (provider, repository, pullRequest, key) => {
          const loaded = await loadGuide(provider, repository, pullRequest);
          const group = loaded?.groups.find((item) => item.key === key);
          if (loaded === undefined || group === undefined) return;
          const marks = groupReadMarks(group, loaded.files, loaded.read, loaded.viewed);
          for (const range of marks.read) await fileReviews.markRead(repository, pullRequest.number, loaded.base, range);
          for (const path of marks.viewed) await fileReviews.set(provider, repository, pullRequest.number, path, true);
        },
      };
    };
    const cleanUp = async (manual: boolean): Promise<void> => {
      const days = vscode.workspace.getConfiguration('pairReview').get<number>('worktreeCleanupDays', 14);
      const results = await Promise.all((await checkouts.list()).map((checkout) => cleanUpWorktrees({
        root: checkout.root, storageRoot: checkout.storageRoot, connect: checkout.connect, remove: worktreesOf(checkout).remove,
      }, days)));
      const removed = results.flatMap((result) => result.removed);
      const kept = results.flatMap((result) => result.kept);
      if (removed.length > 0) {
        void vscode.window.showInformationMessage(`Removed worktrees of merged, closed or unused PRs: ${removed.join(', ')}`);
        void vscode.commands.executeCommand('pairReview.refreshPullRequests');
      }
      if (!manual) return;
      if (kept.length > 0) void vscode.window.showInformationMessage(`Kept ${kept.join(', ')}: uncommitted changes or unpushed commits.`);
      else if (removed.length === 0) void vscode.window.showInformationMessage('No PR worktrees to clean up.');
    };
    if (!mockPullRequests()) void cleanUp(false).catch(() => undefined);
    context.subscriptions.push(
      registerPullRequestView(
        async () => (await checkouts.list()).map((checkout) => ({
          folder: relative(root, checkout.root) || basename(root), connect: checkout.connect, worktrees: worktreesOf(checkout),
        })),
        (listener) => vscode.Disposable.from(
          checkouts.onDidChangeState((changed) => { listener(changed.session.key); }),
          checkouts.onDidChangeReviewedFiles(listener),
        ),
        context.globalState,
        context.workspaceState,
      ),
      watchGitHubSessions(() => { void vscode.commands.executeCommand('pairReview.refreshPullRequests'); }),
      vscode.commands.registerCommand('pairReview.cleanUpWorktrees', async () => {
        try {
          await cleanUp(true);
        } catch (error: unknown) {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
      }),
      vscode.commands.registerCommand('pairReview.signInToGitHub', async (provider: unknown) => {
        try {
          await signInToGitHub(provider === 'github' || provider === 'github-enterprise' ? provider : undefined);
          await vscode.commands.executeCommand('pairReview.refreshPullRequests');
        } catch (error: unknown) {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
      }),
      reportClaudeFailures(checkouts),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('pairReview.mockPullRequests') || event.affectsConfiguration('github-enterprise.uri')) void vscode.commands.executeCommand('pairReview.refreshPullRequests');
      }),
    );
    const bridge = await createReviewBridge(store, join(storage.fsPath, 'selected-session.json'));
    activeBridge = bridge;
    const local = await repositoryRoot(root) === await realpath(root).catch(() => root)
      ? new LocalReview(context, root, store, bridge, join(storage.fsPath, 'local-review')) : undefined;
    context.subscriptions.push(...registerLocalReview(local, store));
    context.subscriptions.push(bridge, registerClaudeLauncher(context, bridge, storage.fsPath), vscode.commands.registerCommand('pairReview.showFocusedClaude', () => {
      const document = vscode.window.activeTextEditor?.document;
      const focused = document === undefined ? undefined : checkouts.forUri(document.uri);
      if (focused !== undefined) showClaude(focused);
    }));
    void checkouts.list().catch((error: unknown) => {
      void vscode.window.showErrorMessage(`Pair Review could not restore pull request reviews: ${error instanceof Error ? error.message : String(error)}`);
    });
    await prepareConnection(context, bridge, storage.fsPath);
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
    status.command = 'pairReview.startClaude';
    const updateStatus = (): void => {
      const document = vscode.window.activeTextEditor?.document;
      const focused = document === undefined ? undefined : checkouts.forUri(document.uri);
      if (focused !== undefined) {
        const current = claudeStatus(focused.runner.activity);
        status.text = `$(${current.icon}) ${focused.session.label} · ${current.text}`;
        status.tooltip = current.retry ? `${focused.runner.activity.error ?? 'Some comments were not picked up.'} Click to send them again.` : `Show what Claude did for ${focused.session.label}`;
        status.command = 'pairReview.showFocusedClaude';
        status.show();
        return;
      }
      status.command = 'pairReview.startClaude';
      const waiting = store.pendingEvents.length;
      const ready = bridge.state.deliveryReady === true;
      const label = !bridge.state.connected ? '$(debug-disconnect) Review · Verbinden'
        : ready ? '$(comment-discussion) Review' : '$(warning) Review · Zustellung pausiert';
      status.text = `${label}${waiting ? ` · ${waiting} wartet` : ''}`;
      status.tooltip = !bridge.state.connected
        ? 'Mit Claude Code verbinden. Abgeschickte Kommentare bleiben bis zur Bestätigung gespeichert.'
        : ready ? 'Automatische Zustellung aktiv. Claude bestätigt jeden Kommentar separat.'
          : 'Claude-Verbindung vorhanden. Die automatische Zustellung ist noch nicht aktiv. Zum Wiederverbinden klicken.';
      status.show();
    };
    context.subscriptions.push(
      status, store.onChange(updateStatus), bridge.onChange(updateStatus),
      checkouts.onDidChangeState(updateStatus), vscode.window.onDidChangeActiveTextEditor(updateStatus),
    );
    updateStatus();
  } catch (error: unknown) {
    activeBridge?.dispose();
    await vscode.window.showErrorMessage(`Pair Review konnte nicht starten: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Finish persisted mutations before VS Code unloads the extension. */
export async function deactivate(): Promise<void> {
  activeBridge?.dispose();
  await activeStore?.flush();
  await activePullRequests?.flush();
  activePullRequests = undefined;
  activeBridge = undefined;
  activeStore = undefined;
}

/** The Git repository's top folder for `folder`, or undefined outside a repository. */
async function repositoryRoot(folder: string): Promise<string | undefined> {
  const top = await git(folder, ['rev-parse', '--show-toplevel']).then((output) => output.trim(), () => undefined);
  return top === undefined ? undefined : await realpath(top).catch(() => top);
}

/** Lines picked in an editor, 1-based; a selection ending at the start of a line leaves that line out. */
function selectedLines(selection: vscode.Selection): { readonly startLine: number; readonly endLine: number } {
  const startLine = selection.start.line + 1;
  const last = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line : selection.end.line + 1;
  return { startLine, endLine: Math.max(startLine, last) };
}

/**
 * The Local view, the local review page and commenting from the editor.
 * Without `local`, when the workspace folder is not a repository's top folder, the view explains that instead.
 */
function registerLocalReview(local: LocalReview | undefined, store: ReviewStore): vscode.Disposable[] {
  void vscode.commands.executeCommand('setContext', 'pairReview.localAvailable', local !== undefined);
  const report = (error: unknown): void => { void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); };
  const run = (action: () => Promise<void>): void => { void action().catch(report); };
  const unavailable = (): void => { void vscode.window.showInformationMessage('Open a Git repository\'s top folder to review its local changes.'); };
  const files = local === undefined ? undefined : new LocalFilesView(local.root, store);
  const disposables: vscode.Disposable[] = [
    vscode.commands.registerCommand('pairReview.openLocalReview', () => { if (local === undefined) unavailable(); else run(() => local.open()); }),
    vscode.commands.registerCommand('pairReview.openLocalFile', (path: unknown) => {
      if (local !== undefined && typeof path === 'string') run(() => local.openFile(path));
    }),
    vscode.commands.registerCommand('pairReview.openLocalFileInEditor', (node: unknown) => {
      const path = typeof node === 'object' && node !== null && 'path' in node && typeof node.path === 'string' ? node.path : undefined;
      if (local !== undefined && path !== undefined && isWorkspaceRelativePath(path)) run(async () => { await vscode.window.showTextDocument(vscode.Uri.file(join(local.root, path)), { preview: false }); });
    }),
    vscode.commands.registerCommand('pairReview.refreshLocalFiles', () => { files?.reload(); }),
    vscode.commands.registerCommand('pairReview.addComment', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined) return;
      const { startLine, endLine } = selectedLines(editor.selection);
      const { uri } = editor.document;
      const address = parsePullRequestFileUri(uri);
      if (address !== undefined) {
        const compose = { path: address.relativePath, side: address.revision === undefined ? 'new' : 'old', startLine, endLine } as const;
        if (!revealOpenPage(`${address.repository}#${address.number}`, { compose })) {
          void vscode.window.showInformationMessage(`Open the review page of #${address.number} first, then comment again.`);
        }
        return;
      }
      const path = local === undefined || uri.scheme !== 'file' ? undefined : relative(local.root, uri.fsPath).split(sep).join('/');
      if (local === undefined || path === undefined || !isWorkspaceRelativePath(path)) {
        void vscode.window.showInformationMessage('Comments work on files of this repository and of checked-out PRs.');
        return;
      }
      run(() => local.commentOn(path, startLine, endLine));
    }),
  ];
  if (local === undefined || files === undefined) return [...disposables, vscode.window.createTreeView('pairReview.local', { treeDataProvider: { getChildren: () => [], getTreeItem: (item: vscode.TreeItem) => item } })];
  let listing: ReturnType<typeof setTimeout> | undefined;
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(local.root, '**/*'), false, true, false);
  const relist = (uri: vscode.Uri): void => {
    if (uri.fsPath.split(/[\\/]/u).includes('.git')) return;
    if (listing !== undefined) clearTimeout(listing);
    listing = setTimeout(() => { listing = undefined; files.reload(); }, 500);
  };
  return [
    ...disposables, local, files, watcher, watcher.onDidCreate(relist), watcher.onDidDelete(relist),
    { dispose: () => { if (listing !== undefined) clearTimeout(listing); } },
    toDisposable(store.onChange(() => { files.redraw(); })),
    vscode.window.createTreeView('pairReview.local', { treeDataProvider: files }),
  ];
}

/** Open a PR's Claude log, and send comments again after a failed or skipped run. */
function showClaude({ runner, output }: PullRequestSession): void {
  if (claudeStatus(runner.activity).retry) runner.retry();
  output.show(true);
}

/** Tell the user once per failed run why Claude did not answer, instead of leaving comments waiting silently. */
function reportClaudeFailures(sessions: Pick<Checkouts, 'onDidChangeState'>): vscode.Disposable {
  const reported = new WeakMap<PullRequestSession, string>();
  return sessions.onDidChangeState((opened) => {
    const { running, error } = opened.runner.activity;
    if (running || error === undefined) {
      reported.delete(opened);
      return;
    }
    if (reported.get(opened) === error) return;
    reported.set(opened, error);
    const log = 'Show log';
    const retry = 'Retry';
    void vscode.window.showErrorMessage(`Claude could not answer on ${opened.session.label}: ${error}`, retry, log).then((choice) => {
      if (choice === retry) opened.runner.retry();
      if (choice === log) opened.output.show(true);
    });
  });
}
