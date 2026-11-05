import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import { anchorFromText } from './anchors.js';
import type { CodeAnchor, ReviewBridge, ReviewStore, ReviewThread } from './contracts.js';
import { DefinitionPeeks } from './definitions.js';
import { readFilePreview, readMediaSides } from './fileContent.js';
import { getHeadRevision, isWorkspaceRelativePath, readGitBase } from './git.js';
import { mediaType } from './media.js';
import { type DiffSelection, type FilesView, type OverviewActions, type OverviewReveal, type OverviewState, type PageComment, revealOpenPage, showPullRequestOverview, threadView } from './pullRequestOverview.js';
import { markRangeRead, readReadRanges, readReviewedFiles, setFileReviewed, unmarkRangesRead } from './reviewedFiles.js';
import { applySuggestion, parseSuggestions } from './suggestions.js';
import { type FileDiff, highlightSource, readPullRequestDiff, wholeFileDiff } from './unifiedDiff.js';
import { prepareHighlighting } from './codePreview.js';
import { git } from './worktrees.js';

const pageKey = 'local';
const extrasKey = 'pairReview.localReview.files';
/** Larger files show as binary instead of being highlighted whole. */
const maxWholeFileBytes = 1024 * 1024;

/** Repository-relative paths Git reports with `-z`, keeping only safe ones. */
export async function gitPaths(root: string, args: readonly string[]): Promise<readonly string[]> {
  return (await git(root, ['-c', 'core.quotePath=false', ...args, '-z'])).split('\0').filter(isWorkspaceRelativePath);
}

/** Every file Git tracks or would track in `root`, without ignored files. */
export function listRepositoryFiles(root: string): Promise<readonly string[]> {
  return gitPaths(root, ['ls-files', '--cached', '--others', '--exclude-standard']);
}

/** A file shown whole, or undefined when it is not a readable file. */
async function wholeFile(root: string, path: string, change: 'added' | 'unchanged'): Promise<FileDiff | undefined> {
  const file = join(root, path);
  const info = await stat(file).catch(() => undefined);
  if (info?.isFile() !== true) return undefined;
  if (info.size > maxWholeFileBytes) return { path, change, binary: true, additions: 0, deletions: 0, hunks: [] };
  return wholeFileDiff(path, await readFile(file), change);
}

/** What Claude's connection shows on the page: whether comments reach a session, and how many wait. */
export function localClaudeStatus(bridge: Pick<ReviewBridge, 'state'>, waiting: number): OverviewState['claude'] {
  const { connected, deliveryReady } = bridge.state;
  const text = !connected ? 'Claude not connected' : deliveryReady === true ? 'Claude connected' : 'Delivery paused';
  return { text: waiting > 0 ? `${text} · ${waiting} waiting` : text, running: false, retry: false };
}

/**
 * The workspace repository's uncommitted changes on the review page.
 * Comments go to the workspace store, which delivers them to the Claude session connected through hooks.
 * Files outside the diff can be opened on the page whole, and stay while they have open threads.
 */
export class LocalReview implements vscode.Disposable {
  readonly #filesChanged = new vscode.EventEmitter<void>();
  /** Fires shortly after files in the repository change on disk. */
  readonly onDidChangeFiles = this.#filesChanged.event;
  readonly #marksChanged = new vscode.EventEmitter<void>();
  readonly #disposables: vscode.Disposable[] = [this.#filesChanged, this.#marksChanged];
  readonly #definitions: DefinitionPeeks;
  /** Paths the last file read showed, which comments and marks must stay inside. */
  #shown: readonly FileDiff[] = [];
  #selection: DiffSelection = { range: { kind: 'all' }, whitespace: false };
  /** Suggestion options written to files while the page is open, by thread, and the content before, so Discard can put it back. */
  readonly #applied = new Map<string, { readonly message: number; readonly option: number; readonly path: string; readonly before: string; readonly after: string }>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    /** The repository's top folder, which is also the workspace folder. */
    readonly root: string,
    private readonly store: ReviewStore,
    private readonly bridge: ReviewBridge,
    /** Where review marks are kept, outside the repository. */
    private readonly dataPath: string,
  ) {
    this.#definitions = new DefinitionPeeks(root);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
    const changed = (uri: vscode.Uri): void => {
      const inGit = uri.fsPath.split(/[\\/]/u).includes('.git');
      if (inGit && !/[\\/]\.git[\\/](?:HEAD|index)$/u.test(uri.fsPath)) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; this.#filesChanged.fire(); }, 500);
    };
    this.#disposables.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed),
      { dispose: () => { if (timer !== undefined) clearTimeout(timer); } });
  }

  /** Whether a path is part of the page's last file read. */
  #shows(path: string): boolean {
    return this.#shown.some((file) => file.path === path);
  }

  #extras(): readonly string[] {
    return this.context.workspaceState.get<readonly string[]>(extrasKey, []).filter(isWorkspaceRelativePath);
  }

  async #keep(path: string): Promise<void> {
    const extras = this.#extras();
    if (!extras.includes(path)) await this.context.workspaceState.update(extrasKey, [...extras, path]);
  }

  /** Open the page, scrolled to `reveal` when given. */
  async open(reveal?: OverviewReveal): Promise<void> {
    if (revealOpenPage(pageKey, reveal)) return;
    await showPullRequestOverview(pageKey, () => this.#read(), (listener) => vscode.Disposable.from(
      toDisposable(this.store.onChange(() => { listener(undefined); })),
      toDisposable(this.bridge.onChange(() => { listener(undefined); })),
      this.#marksChanged.event(listener),
    ), this.#actions(), this.context.extensionUri, reveal, this.onDidChangeFiles);
  }

  /** Show a file on the page, whole when it has no changes. */
  async openFile(path: string): Promise<void> {
    if (!isWorkspaceRelativePath(path)) throw new Error(`Unsupported file path: ${path}`);
    await this.#keep(path);
    await this.open({ path, reload: true });
  }

  /** Open a new comment on lines of a file, showing the file first. */
  async commentOn(path: string, startLine: number, endLine: number): Promise<void> {
    if (!isWorkspaceRelativePath(path)) throw new Error(`Unsupported file path: ${path}`);
    await this.#keep(path);
    await this.open({ compose: { path, side: 'new', startLine, endLine } });
  }

  async #base(): Promise<string> {
    return await getHeadRevision(this.root) ?? 'unborn';
  }

  /** Changed files against HEAD, untracked files as added, then kept files and files with open threads shown whole. */
  async readFiles(select?: DiffSelection): Promise<FilesView> {
    const whitespace = select?.whitespace ?? this.#selection.whitespace;
    const head = await getHeadRevision(this.root);
    const [tracked, untracked] = await Promise.all([
      head === undefined ? [] : readPullRequestDiff(this.root, head, { ignoreWhitespace: whitespace }),
      head === undefined ? listRepositoryFiles(this.root) : gitPaths(this.root, ['ls-files', '--others', '--exclude-standard']),
    ]);
    const changed = new Set([...tracked.map((file) => file.path), ...untracked]);
    const threadPaths = this.store.threads.filter((thread) => !thread.resolved).map((thread) => thread.anchor.path);
    const extras = [...new Set([...this.#extras(), ...threadPaths])].filter((path) => !changed.has(path));
    await prepareHighlighting([...untracked, ...extras]);
    const whole = await Promise.all([
      ...untracked.map((path) => wholeFile(this.root, path, 'added')),
      ...extras.map((path) => wholeFile(this.root, path, 'unchanged')),
    ]);
    const files = [...tracked, ...whole.filter((file) => file !== undefined)].sort((a, b) => a.path.localeCompare(b.path));
    this.#shown = files;
    this.#selection = { range: { kind: 'all' }, whitespace };
    // Viewed marks and progress count the files shown, so the page's state is read again for them.
    this.#marksChanged.fire();
    return { files, selection: this.#selection, atHead: true };
  }

  async #read(): Promise<OverviewState> {
    const base = await this.#base();
    const paths = this.#shown.map((file) => file.path);
    const [viewed, read, branch] = await Promise.all([
      readReviewedFiles(this.root, paths, this.dataPath),
      readReadRanges(this.root, base, this.dataPath).catch(() => []),
      git(this.root, ['branch', '--show-current']).then((name) => name.trim() || base.slice(0, 7), () => base.slice(0, 7)),
    ]);
    return {
      local: true,
      title: 'Local changes',
      heading: basename(this.root),
      author: '',
      headBranch: branch,
      baseBranch: 'HEAD',
      url: '',
      viewed: [...viewed],
      read,
      reviewed: { done: viewed.size, total: paths.length },
      claude: localClaudeStatus(this.bridge, this.store.pendingEvents.length),
      analysis: { running: false, stale: false },
      threads: this.store.threads.map((thread) => {
        const view = threadView(thread);
        const applied = this.#applied.get(thread.id);
        return applied === undefined ? view : { ...view, applied: { message: applied.message, option: applied.option, done: 'applied' as const } };
      }),
    };
  }

  #findThread(id: string): ReviewThread {
    const thread = this.store.threads.find((candidate) => candidate.id === id);
    if (thread === undefined) throw new Error('This thread no longer exists.');
    return thread;
  }

  async #anchor({ path, side, startLine, endLine }: Omit<PageComment, 'text' | 'intent'>): Promise<CodeAnchor> {
    if (!this.#shows(path)) throw new Error(`${path} is not on this page.`);
    const base = await this.#base();
    const content = side === 'old' ? await readGitBase(this.root, path, base) : await readFile(join(this.root, path), 'utf8');
    return anchorFromText(content, { path, startLine, endLine, side: side === 'old' ? 'original' : 'working', baseRevision: base });
  }

  #fileUri(path: string): vscode.Uri {
    return vscode.Uri.file(join(this.root, path));
  }

  #actions(): OverviewActions {
    const unsupported = (): Promise<never> => Promise.reject(new Error('This needs a pull request.'));
    const onPage = (path: string): void => { if (!this.#shows(path)) throw new Error(`${path} is not on this page.`); };
    return {
      readFiles: (select) => this.readFiles(select),
      readContext: async (path) => {
        onPage(path);
        await prepareHighlighting([path]);
        return highlightSource(await readFile(join(this.root, path), 'utf8'), path);
      },
      readPreview: async (path) => { onPage(path); return readFilePreview(this.root, path); },
      readMedia: async (path) => {
        const file = this.#shown.find((each) => each.path === path);
        if (file === undefined || mediaType(path) === undefined) throw new Error(`${path} is not an image or PDF on this page.`);
        return readMediaSides(this.root, file, await this.#base());
      },
      findDefinition: async (at, line, column) => {
        if ('peek' in at) return this.#definitions.find(this.#definitions.location(at.peek).uri, line, column);
        onPage(at.path);
        return this.#definitions.find(this.#fileUri(at.path), line, column);
      },
      hasDefinition: async (at, line, column) => {
        if ('peek' in at) return this.#definitions.has(this.#definitions.location(at.peek).uri, line, column);
        return this.#shows(at.path) && this.#definitions.has(this.#fileUri(at.path), line, column);
      },
      missingLanguage: async (at) => {
        if ('peek' in at) return this.#definitions.missingLanguage(this.#definitions.location(at.peek).uri);
        return this.#shows(at.path) ? this.#definitions.missingLanguage(this.#fileUri(at.path)) : undefined;
      },
      openDefinition: async (peek) => {
        const { uri, range } = this.#definitions.location(peek);
        await vscode.window.showTextDocument(uri, { selection: range, preview: true });
      },
      comment: async ({ text, intent, ...lines }) => { await this.store.submit(await this.#anchor(lines), text, intent); },
      reply: async (id, text, intent) => {
        const thread = this.#findThread(id);
        if (thread.resolved) throw new Error('Reopen this thread before replying.');
        await this.store.submit(thread.anchor, text, intent, id);
      },
      resolve: (id, resolved) => this.store.resolve(this.#findThread(id).id, resolved),
      setViewed: async (path, viewed) => {
        onPage(path);
        await setFileReviewed(this.root, path, viewed, this.dataPath);
        this.#marksChanged.fire();
      },
      markRead: async (range, fileDone) => {
        onPage(range.path);
        await markRangeRead(this.root, await this.#base(), range, this.dataPath);
        if (fileDone) await setFileReviewed(this.root, range.path, true, this.dataPath);
        this.#marksChanged.fire();
      },
      unmarkRead: async (ids) => {
        await unmarkRangesRead(this.root, ids, this.dataPath);
        this.#marksChanged.fire();
      },
      openInEditor: async (path) => { await vscode.window.showTextDocument(this.#fileUri(path), { preview: false }); },
      closeFile: async (path) => {
        await this.context.workspaceState.update(extrasKey, this.#extras().filter((each) => each !== path));
      },
      openTerminal: async () => { await vscode.commands.executeCommand('pairReview.startClaude'); },
      revealThread: async (id) => { await this.openFile(this.#findThread(id).anchor.path); },
      applySuggestion: async (id, message, option) => {
        const { anchor, messages } = this.#findThread(id);
        const suggestion = parseSuggestions(messages[message]?.text ?? '')[option];
        if (suggestion === undefined) throw new Error('This suggestion no longer exists.');
        if (anchor.side !== 'working') throw new Error('Suggestions apply only to the current version of a file.');
        const file = join(this.root, anchor.path);
        const before = await readFile(file, 'utf8');
        const after = applySuggestion(before, anchor, suggestion);
        await writeFile(file, after);
        this.#applied.set(id, { message, option, path: anchor.path, before, after });
        this.#marksChanged.fire();
      },
      discardSuggestion: async (id) => {
        const change = this.#applied.get(id);
        if (change === undefined) throw new Error('There is no applied suggestion to discard.');
        const file = join(this.root, change.path);
        if (await readFile(file, 'utf8') !== change.after) throw new Error(`${change.path} changed since the suggestion was applied, so it was not discarded.`);
        await writeFile(file, change.before);
        this.#applied.delete(id);
        this.#marksChanged.fire();
      },
      pollGitHub: async () => ({ reload: false, files: false }),
      refresh: () => undefined,
      retry: () => undefined,
      dismissConflictQuestion: () => undefined,
      stopAnalysis: () => undefined,
      publish: unsupported, postToGitHub: unsupported, commentOnGitHub: unsupported, replyOnGitHub: unsupported, askAboutGitHub: unsupported, resolveOnGitHub: unsupported,
      deleteOnGitHub: unsupported, push: unsupported, readCommit: unsupported, submitReview: unsupported, merge: unsupported, addComment: unsupported,
      editComment: unsupported, deleteIssueComment: unsupported, hideComment: unsupported, react: unsupported, discardReview: unsupported,
      dismissReview: unsupported, rerequestReview: unsupported, updateBranch: unsupported, enableAutoMerge: unsupported, disableAutoMerge: unsupported,
      enqueue: unsupported, dequeue: unsupported, revert: unsupported, restoreBranch: unsupported, rerun: unsupported, approveRuns: unsupported,
      branches: unsupported, changeBase: unsupported, renderMarkdown: unsupported, commitSuggestions: unsupported, publishSuggestion: unsupported,
      fixConflicts: unsupported, editTitle: unsupported, editBody: unsupported, pickerOptions: unsupported, pick: unsupported, setDraft: unsupported,
      setOpen: unsupported, deleteBranch: unsupported, removeWorktree: unsupported, analyze: unsupported,
    };
  }

  dispose(): void {
    for (const disposable of this.#disposables) disposable.dispose();
  }
}

/** A store or bridge subscription as a VS Code disposable. */
export function toDisposable(disposable: { dispose(): void }): vscode.Disposable {
  return { dispose: () => { disposable.dispose(); } };
}
