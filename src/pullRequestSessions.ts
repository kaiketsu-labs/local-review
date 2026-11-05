import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { createReviewBridge } from './bridge.js';
import { readCustomInstructions, type InstructionKind } from './customInstructions.js';
import type { CodeAnchor, ReviewBridge, ReviewStore } from './contracts.js';
import { parsePullRequestFileUri, pullRequestFileUri } from './pullRequestDiff.js';
import { type CommentPlacement, placeComment, publishableText, readClaudeCommits, readGitHubLinks, readPublications, writeClaudeCommits, writeGitHubLinks, writePublications } from './pullRequestComments.js';
import type { PullRequestProvider, PullRequestSummary } from './pullRequests.js';
import { showPublishPanel } from './publishPanel.js';
import type { ReviewSession, ReviewSessionSource } from './reviewSession.js';
import { ClaudeRunner, type ClaudeRunnerOptions } from './claudeRunner.js';
import { catchUpWithPullRequest, commitsSince, discardSince, worktreeSnapshot, type WorktreeCommit } from './conflicts.js';
import { PullRequestAnalysis } from './prAnalysisRunner.js';
import { requireNodeRuntime, resolveExecutable } from './executables.js';
import { prepareConnection } from './setup.js';
import { createReviewStore } from './store.js';
import { listWorktrees, migrateWorktrees, type PullRequestWorktree, readPullRequestBase, readWorktree, reviewDataPath, worktreePath } from './worktrees.js';

/** A PR's review: its comments, the bridge Claude replies through, and the background Claude that answers them. */
export interface PullRequestSession {
  readonly session: ReviewSession;
  readonly bridge: ReviewBridge;
  readonly runner: ClaudeRunner;
  /** Claude's guided-review analysis of the PR. */
  readonly analysis: PullRequestAnalysis;
  /** Full log of what Claude did for this PR. */
  readonly output: vscode.OutputChannel;
  /** Commits Claude made while answering a local thread, oldest first. */
  readonly commits: (threadId: string) => readonly WorktreeCommit[];
  /** False when the PR is open on a checkout whose own review keeps the bridge, and a connected conversation answers. */
  readonly ownsBridge: boolean;
}

/** Review sessions for the PR worktrees of one checkout, opened on demand and restored on startup. */
export class PullRequestSessions implements ReviewSessionSource, vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.#changed.event;
  readonly #stateChanged = new vscode.EventEmitter<PullRequestSession>();
  /** Fires when a PR's comments or Claude activity change. */
  readonly onDidChangeState = this.#stateChanged.event;
  readonly onDidChangeActivity = this.#stateChanged.event;
  readonly #watchers = new Map<string, vscode.Disposable>();
  readonly #open = new Map<string, Promise<PullRequestSession>>();
  readonly #ready = new Map<string, PullRequestSession>();
  /** Your own PRs opened on checkouts that have their own review, by PR and folder. */
  readonly #onCheckouts = new Map<string, Promise<PullRequestSession>>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly storageRoot: string,
    private readonly sourceRoot: string,
    /** The code host that published threads go to. */
    private readonly connect: () => Promise<PullRequestProvider>,
    /** Replaces how Claude is found and started, for tests. */
    private readonly claude: Partial<Pick<ClaudeRunnerOptions, 'resolve' | 'spawn'>> = {},
  ) {}

  get sessions(): readonly ReviewSession[] {
    return [...this.#ready.values()].map(({ session }) => session);
  }

  /** Session that owns a PR file document, if it is open. */
  forUri(uri: vscode.Uri): PullRequestSession | undefined {
    const address = parsePullRequestFileUri(uri);
    return address === undefined ? undefined : this.#ready.get(key(address.repository, address.number));
  }

  /** The open session of a PR, if any. */
  get(repository: string, number: number): PullRequestSession | undefined {
    return this.#ready.get(key(repository, number));
  }

  /** Open the session for a PR whose worktree exists; repeated calls share one session. */
  open(repository: string, number: number): Promise<PullRequestSession> {
    const id = key(repository, number);
    let pending = this.#open.get(id);
    if (pending === undefined) {
      pending = this.#create(repository, number);
      this.#open.set(id, pending);
      const opening = pending;
      opening.then((session) => {
        if (this.#open.get(id) !== opening) {
          release(session);
          return;
        }
        this.#ready.set(id, session);
        const fire = (): void => { this.#stateChanged.fire(session); };
        this.#watchers.set(id, vscode.Disposable.from(session.session.store.onChange(fire), session.runner.onDidChange(fire), session.analysis.onDidChange(fire)));
        this.#changed.fire();
        fire();
      }, () => { if (this.#open.get(id) === opening) this.#open.delete(id); });
    }
    return pending;
  }

  /** Reopen sessions for worktrees this checkout created earlier, so their comments come back. */
  async restore(): Promise<void> {
    const stuck = await migrateWorktrees(this.sourceRoot, this.storageRoot);
    if (stuck.length > 0) {
      void vscode.window.showWarningMessage(`Pair Review could not move ${stuck.length === 1 ? 'a PR worktree' : `${stuck.length} PR worktrees`} out of the Git folder, so Claude cannot edit there: ${stuck.join(', ')}`);
    }
    for (const { metadata } of await listWorktrees(this.storageRoot, this.sourceRoot)) {
      await this.open(metadata.repository, metadata.pullRequest.number);
    }
  }

  /** Stop a PR's connection and save its comments before its worktree goes away. */
  async close(repository: string, number: number): Promise<void> {
    const id = key(repository, number);
    const pending = this.#open.get(id);
    this.#open.delete(id);
    this.#ready.delete(id);
    this.#watchers.get(id)?.dispose();
    this.#watchers.delete(id);
    if (pending === undefined) return;
    const closing = await pending.catch(() => undefined);
    if (closing === undefined) return;
    release(closing);
    await closing.session.store.flush();
    this.#changed.fire();
  }

  dispose(): void {
    for (const session of this.#ready.values()) release(session);
    for (const pending of this.#onCheckouts.values()) void pending.then(release, () => undefined);
    this.#onCheckouts.clear();
    for (const watcher of this.#watchers.values()) watcher.dispose();
    this.#watchers.clear();
    this.#ready.clear();
    this.#open.clear();
    this.#changed.dispose();
    this.#stateChanged.dispose();
  }

  /** Flush every PR's comments before the extension unloads. */
  async flush(): Promise<void> {
    await Promise.all([...this.#ready.values()].map(({ session }) => session.store.flush()));
  }

  /**
   * Open your own PR on a checkout that already has a review, such as the folder you work in.
   * Its comments stay in that review and reach the conversation you connected; the session's own Claude only builds the guide.
   */
  async openOnCheckout(repository: string, pullRequest: PullRequestSummary, checkout: { readonly root: string; readonly store: ReviewStore; readonly bridge: ReviewBridge; readonly dataPath: string }): Promise<PullRequestSession> {
    const id = `${key(repository, pullRequest.number)}@${checkout.root}`;
    let pending = this.#onCheckouts.get(id);
    if (pending === undefined) {
      const dataPath = checkoutDataPath(checkout.dataPath, repository, pullRequest.number);
      pending = mkdir(dataPath, { recursive: true, mode: 0o700 }).then(() => this.#build(repository, pullRequest.number, checkout.root,
        { version: 1, repository, role: 'author', pullRequest }, { store: checkout.store, bridge: checkout.bridge, dataPath, ownsBridge: false }));
      this.#onCheckouts.set(id, pending);
      const opening = pending;
      opening.then((session) => {
        const fire = (): void => { this.#stateChanged.fire(session); };
        this.#watchers.set(id, vscode.Disposable.from(session.session.store.onChange(fire), session.analysis.onDidChange(fire)));
      }, () => { if (this.#onCheckouts.get(id) === opening) this.#onCheckouts.delete(id); });
    }
    return pending;
  }

  async #create(repository: string, number: number): Promise<PullRequestSession> {
    const worktree = worktreePath(this.storageRoot, repository, number);
    const metadata = await readWorktree(this.storageRoot, worktree);
    if (metadata === undefined) throw new Error(`#${number} has no worktree.`);
    const dataPath = reviewDataPath(worktree);
    await mkdir(dataPath, { recursive: true, mode: 0o700 });
    const store = await createReviewStore(join(dataPath, 'review.json'), worktree);
    const bridge = await createReviewBridge(store, join(dataPath, 'selected-session.json'));
    try {
      await prepareConnection(this.context, bridge, dataPath);
    } catch (error: unknown) {
      bridge.dispose();
      throw error;
    }
    return this.#build(repository, number, worktree, metadata, { store, bridge, dataPath, ownsBridge: true });
  }

  /** A PR session over `worktree`; with a bridge it does not own, a connected conversation answers and the bridge outlives the session. */
  async #build(repository: string, number: number, worktree: string, metadata: PullRequestWorktree,
    { store, bridge, dataPath, ownsBridge }: { readonly store: ReviewStore; readonly bridge: ReviewBridge; readonly dataPath: string; readonly ownsBridge: boolean }): Promise<PullRequestSession> {
    const publications = await readPublications(dataPath);
    const links = await readGitHubLinks(dataPath);
    const commits = await readClaudeCommits(dataPath);
    const publishing = new Map<string, vscode.WebviewPanel>();
    const output = vscode.window.createOutputChannel(`Claude · #${number}`);
    const configuration = vscode.workspace.getConfiguration('pairReview');
    const log = (line: string): void => { output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`); };
    const resolve: ClaudeRunnerOptions['resolve'] = async () => {
      const claudePath = configuration.get<string>('claudePath', 'claude');
      const shell = loginShell();
      const [executable, nodePath] = await Promise.all([
        shell === undefined ? resolveExecutable(claudePath, worktree) : claudePath,
        resolveExecutable(configuration.get<string>('nodePath', 'node'), worktree),
      ]);
      await requireNodeRuntime(nodePath);
      const mcpPath = (await prepareConnection(this.context, bridge, dataPath, nodePath)).mcpPath;
      return shell === undefined ? { executable, mcpPath } : { executable, mcpPath, shell };
    };
    const instructions = (kind: InstructionKind) => async (): Promise<string> => {
      const revision = metadata.role === 'reviewer' ? await readPullRequestBase(worktree, metadata.pullRequest.baseBranch) : undefined;
      if (metadata.role === 'reviewer' && revision === undefined) log('Skipping the repository\'s review instructions: could not find the base branch.');
      return readCustomInstructions(kind, { projectRoot: this.sourceRoot, repository: { cwd: worktree, ...(revision === undefined ? {} : { revision }) } });
    };
    /** The worktree before Claude's current run, to find its commits or undo its throwaway changes. */
    let before: Awaited<ReturnType<typeof worktreeSnapshot>> | undefined;
    const runner = new ClaudeRunner({
      store, cwd: worktree, dataPath, role: metadata.role, log, resolve, instructions: instructions('comments'),
      folders: () => [...new Set([this.sourceRoot, ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)])],
      prepare: async () => {
        if (!await catchUpWithPullRequest(worktree, number)) log('Could not reach GitHub for the PR\'s latest commit; Claude works on the worktree as it is.');
        before = await worktreeSnapshot(worktree);
      },
      finish: async (threads) => {
        const start = before;
        before = undefined;
        if (start === undefined) return;
        if (metadata.role === 'reviewer') {
          if (start.clean) await discardSince(worktree, start.head);
          else log('Kept the worktree as it is: it had uncommitted changes before Claude started.');
          return;
        }
        const made = await commitsSince(worktree, start.head).catch(() => []);
        if (made.length === 0) return;
        for (const threadId of threads) commits.set(threadId, [...commits.get(threadId) ?? [], ...made]);
        await writeClaudeCommits(dataPath, commits);
      },
      ...this.claude,
      ...ownsBridge ? {} : { answersElsewhere: true },
    });
    const analysis = new PullRequestAnalysis({ store, cwd: worktree, dataPath, role: metadata.role, log, resolve, instructions: instructions('guide'), ...this.claude });
    const record = async (threadId: string, url: string, pending: boolean): Promise<void> => {
      publications.set(threadId, { url, pending });
      await writePublications(dataPath, publications);
      this.#stateChanged.fire(result);
      void vscode.window.showInformationMessage(pending ? 'Added to your pending review on GitHub.' : 'Posted on GitHub.', 'Open')
        .then((choice) => { if (choice !== undefined) void vscode.env.openExternal(vscode.Uri.parse(url)); });
    };
    const place = async (anchor: CodeAnchor): Promise<CommentPlacement> => {
      const base = await readPullRequestBase(worktree, metadata.pullRequest.baseBranch);
      if (base === undefined) throw new Error(`Could not find where #${number} branched off ${metadata.pullRequest.baseBranch}.`);
      return placeComment(worktree, base, anchor);
    };
    const commentOnDiff = async (threadId: string, placement: CommentPlacement, body: string, pending: boolean): Promise<void> => {
      const url = await (await this.connect()).publishComment(number, { ...placement, body }, pending);
      await record(threadId, url, pending);
    };
    const session: ReviewSession = {
      key: key(repository, number),
      label: `#${number}`,
      store,
      resolveBase: () => readPullRequestBase(worktree, metadata.pullRequest.baseBranch),
      locate: (uri) => {
        const address = parsePullRequestFileUri(uri);
        if (address === undefined || address.repository !== repository || address.number !== number) return undefined;
        return address.revision === undefined
          ? { path: address.relativePath, original: false }
          : { path: address.relativePath, original: true, revision: address.revision };
      },
      workingUri: (relativePath) => pullRequestFileUri({ repository, number, relativePath }),
      originalUri: (relativePath, revision) => pullRequestFileUri({ repository, number, relativePath, revision }),
      activity: (threadId) => {
        const { running, step, threads, error, skipped } = runner.activity;
        if (!threads.has(threadId)) return undefined;
        if (running) return `Claude · ${step ?? 'Working'}`;
        if (error !== undefined) return `Claude failed · ${error}`;
        return skipped > 0 && store.pendingEvents.some((event) => event.threadId === threadId) ? 'Not picked up by Claude' : undefined;
      },
      publication: (threadId) => publications.get(threadId),
      publish: async (threadId) => {
        const thread = store.threads.find((candidate) => candidate.id === threadId);
        if (thread === undefined) return;
        const published = publications.get(threadId);
        if (published !== undefined) {
          await vscode.env.openExternal(vscode.Uri.parse(published.url));
          return;
        }
        const open = publishing.get(threadId);
        if (open !== undefined) {
          open.reveal();
          return;
        }
        const { startLine, endLine, path } = thread.anchor;
        const lines = lineLabel(thread.anchor);
        const text = publishableText(thread);
        const link = links.get(threadId);
        if (link !== undefined) {
          const panel = showPublishPanel({ title: `#${number} · ${path}:${lines}`, placement: 'Reply in the GitHub thread', body: text, reply: true }, async (body) => {
            await (await this.connect()).replyToThread(link.id, body);
            await record(threadId, link.url, false);
          });
          publishing.set(threadId, panel);
          panel.onDidDispose(() => { publishing.delete(threadId); });
          return;
        }
        const placement = await place(thread.anchor);
        const panel = showPublishPanel({
          title: `#${number} · ${path}:${lines}`,
          placement: placement.lines === undefined ? `Whole file: line ${lines} is outside the PR diff` : `${endLine === startLine ? 'Line' : 'Lines'} ${lines}`,
          body: `${placement.lines === undefined ? `Line ${lines}:\n\n` : ''}${text}`,
        }, (body, pending) => commentOnDiff(threadId, placement, body, pending));
        publishing.set(threadId, panel);
        panel.onDidDispose(() => { publishing.delete(threadId); });
      },
      postToGitHub: async (threadId, body, pending) => {
        const thread = store.threads.find((candidate) => candidate.id === threadId);
        if (thread === undefined) throw new Error('This thread no longer exists.');
        const placement = await place(thread.anchor);
        await commentOnDiff(threadId, placement, `${placement.lines === undefined ? `Line ${lineLabel(thread.anchor)}:\n\n` : ''}${body}`, pending);
      },
      linkToGitHub: async (threadId, link) => {
        links.set(threadId, link);
        await writeGitHubLinks(dataPath, links);
      },
      linkedGitHubThread: (threadId) => links.get(threadId)?.id,
    };
    const result: PullRequestSession = { session, bridge, runner, analysis, output, commits: (threadId) => commits.get(threadId) ?? [], ownsBridge };
    return result;
  }
}

/** Where a PR open on a checkout keeps its publications, links and review marks, inside that checkout's review folder. */
export function checkoutDataPath(reviewFolder: string, repository: string, number: number): string {
  return join(reviewFolder, 'pull-requests', `${repository.replace('/', '__')}-${number}`);
}

/** Such as "12" or "12–14". */
function lineLabel({ startLine, endLine }: CodeAnchor): string {
  return endLine === startLine ? `${startLine}` : `${startLine}–${endLine}`;
}

/** Stop a PR's Claude and its connection. */
function release({ runner, analysis, bridge, output, ownsBridge }: PullRequestSession): void {
  runner.dispose();
  analysis.dispose();
  if (ownsBridge) bridge.dispose();
  output.dispose();
}

/** The user's login shell, when it is one Claude can be started through like in a terminal. */
function loginShell(): string | undefined {
  const shell = process.env['SHELL'];
  return shell !== undefined && /\/(zsh|bash)$/u.test(shell) ? shell : undefined;
}

/** Identify a PR across repositories. */
function key(repository: string, number: number): string {
  return `${repository}#${number}`;
}
