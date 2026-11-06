import { readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import type { FileReviews } from './reviewedFiles.js';
import type { PullRequestProvider } from './pullRequests.js';
import type { PullRequestSession, PullRequestSessions } from './pullRequestSessions.js';
import type { ReviewSession, ReviewSessionSource } from './reviewSession.js';
import { hasWorktree, repositoryStorage } from './worktrees.js';

/** One local Git repository whose pull requests can be reviewed, with its own PR worktrees and sessions. */
export interface Checkout {
  readonly root: string;
  readonly storageRoot: string;
  readonly connect: () => Promise<PullRequestProvider>;
  readonly sessions: PullRequestSessions;
  readonly fileReviews: FileReviews;
}

/** How a checkout's parts are found and built, kept injectable for tests. */
export interface CheckoutOptions {
  /** Root folders of Git repositories VS Code found, in any order. */
  readonly discover: () => Promise<readonly string[]>;
  /** Storage for PR worktrees of a repository, or undefined when it is not a Git repository. */
  readonly storage?: (root: string) => Promise<string | undefined>;
  readonly create: (root: string, storageRoot: string) => Checkout;
  readonly onRestoreError: (error: unknown) => void;
}

/** PR checkouts for the workspace folder and the Git repositories nested inside it. */
export class Checkouts implements ReviewSessionSource, vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.#changed.event;
  readonly #stateChanged = new vscode.EventEmitter<PullRequestSession>();
  /** Fires when a PR's comments or Claude activity change, in any checkout. */
  readonly onDidChangeState = this.#stateChanged.event;
  readonly onDidChangeActivity = this.#stateChanged.event;
  readonly #reviewsChanged = new vscode.EventEmitter<string>();
  /** Fires with `owner/name#number` when a file is ticked or unticked as reviewed, in any checkout. */
  readonly onDidChangeReviewedFiles = this.#reviewsChanged.event;
  readonly #byStorage = new Map<string, Checkout>();
  readonly #storage = new Map<string, Promise<string | undefined>>();
  #discovered: Promise<readonly string[]> | undefined;
  /** Checkout that held each PR's worktree when last looked up. */
  readonly #located = new Map<string, Checkout>();
  readonly #subscriptions: vscode.Disposable[] = [];

  /** `fallbackStorage` keeps PR worktrees when the workspace folder itself is not a Git repository. */
  constructor(private readonly workspaceRoot: string, private readonly fallbackStorage: string, private readonly options: CheckoutOptions) {}

  get sessions(): readonly ReviewSession[] {
    return [...this.#byStorage.values()].flatMap((checkout) => checkout.sessions.sessions);
  }

  /** The workspace folder first, then nested repositories by path; worktrees of one repository count once. */
  async list(): Promise<readonly Checkout[]> {
    const nested = (await this.#discover()).filter((root) => isNested(this.workspaceRoot, root)).sort();
    const candidates = await Promise.all([this.workspaceRoot, ...nested].map(async (root) => ({
      root, storageRoot: await this.#storageOf(root) ?? (root === this.workspaceRoot ? this.fallbackStorage : undefined),
    })));
    const listed = new Map<string, Checkout>();
    for (const { root, storageRoot } of candidates) {
      if (storageRoot === undefined || listed.has(storageRoot)) continue;
      listed.set(storageRoot, this.#checkout(root, storageRoot));
    }
    return [...listed.values()];
  }

  /** Scan the workspace folder for repositories again on the next `list`. */
  rescan(): void {
    this.#discovered = undefined;
  }

  /** The checkout that holds a PR's worktree, if any; looks again in every repository, rescanning once, when the last answer no longer holds. */
  async locate(repository: string, number: number): Promise<Checkout | undefined> {
    const key = `${repository}#${number}`;
    const known = this.#located.get(key);
    if (known !== undefined && await hasWorktree(known.storageRoot, repository, number)) return known;
    this.#located.delete(key);
    let found = await this.#find(await this.list(), repository, number);
    if (found === undefined) {
      this.rescan();
      found = await this.#find(await this.list(), repository, number);
    }
    if (found !== undefined) this.#located.set(key, found);
    return found;
  }

  /** The checkout of the repository a folder belongs to, such as one of its worktrees; undefined outside a Git repository. */
  async forFolder(folder: string): Promise<Checkout | undefined> {
    const storageRoot = await this.#storageOf(folder);
    if (storageRoot === undefined) return undefined;
    await this.list();
    return this.#byStorage.get(storageRoot) ?? this.#checkout(folder, storageRoot);
  }

  /** Session that owns a PR file document, if it is open. */
  forUri(uri: vscode.Uri): PullRequestSession | undefined {
    for (const checkout of this.#byStorage.values()) {
      const found = checkout.sessions.forUri(uri);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** Flush every PR's comments before the extension unloads. */
  async flush(): Promise<void> {
    await Promise.all([...this.#byStorage.values()].map((checkout) => checkout.sessions.flush()));
  }

  dispose(): void {
    for (const subscription of this.#subscriptions) subscription.dispose();
    for (const checkout of this.#byStorage.values()) {
      checkout.sessions.dispose();
      checkout.fileReviews.dispose();
    }
    this.#byStorage.clear();
    this.#changed.dispose();
    this.#stateChanged.dispose();
    this.#reviewsChanged.dispose();
  }

  async #find(checkouts: readonly Checkout[], repository: string, number: number): Promise<Checkout | undefined> {
    const held = await Promise.all(checkouts.map((checkout) => hasWorktree(checkout.storageRoot, repository, number)));
    return checkouts.find((_checkout, index) => held[index]);
  }

  #discover(): Promise<readonly string[]> {
    if (this.#discovered === undefined) {
      const discovered = this.#discovered = this.options.discover();
      discovered.catch(() => { if (this.#discovered === discovered) this.#discovered = undefined; });
    }
    return this.#discovered;
  }

  #storageOf(root: string): Promise<string | undefined> {
    let found = this.#storage.get(root);
    if (found === undefined) {
      found = (this.options.storage ?? repositoryStorage)(root).catch(() => undefined);
      this.#storage.set(root, found);
    }
    return found;
  }

  /** Build a checkout once and bring back the PR reviews it created earlier. */
  #checkout(root: string, storageRoot: string): Checkout {
    const known = this.#byStorage.get(storageRoot);
    if (known !== undefined) return known;
    const checkout = this.options.create(root, storageRoot);
    this.#byStorage.set(storageRoot, checkout);
    this.#subscriptions.push(
      checkout.sessions.onDidChange(() => { this.#changed.fire(); }),
      checkout.sessions.onDidChangeState((session) => { this.#stateChanged.fire(session); }),
      checkout.fileReviews.onDidChange((pullRequest) => { this.#reviewsChanged.fire(pullRequest); }),
    );
    void checkout.sessions.restore().catch(this.options.onRestoreError);
    return checkout;
  }
}

/** Whether `root` lies inside the workspace folder and not inside a Git or Claude folder, where worktrees live. */
function isNested(workspaceRoot: string, root: string): boolean {
  const inside = relative(workspaceRoot, root);
  const parts = inside.split(sep);
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside) && !parts.includes('.git') && !parts.includes('.claude');
}

/** Git repositories inside the workspace folder, found like VS Code's Git extension does but without waiting for its full scan. */
export async function nestedRepositoryRoots(workspaceRoot: string): Promise<readonly string[]> {
  const git = vscode.workspace.getConfiguration('git');
  if (!git.get('enabled', true)) return [];
  const maxDepth = git.get<number>('repositoryScanMaxDepth', 1);
  const ignored = new Set(git.get<readonly string[]>('repositoryScanIgnoredFolders', ['node_modules']));
  const found: string[] = [];
  const scan = async (folder: string, depth: number): Promise<void> => {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    if (folder !== workspaceRoot && entries.some((entry) => entry.name === '.git')) found.push(folder);
    if (maxDepth >= 0 && depth >= maxDepth) return;
    await Promise.all(entries.filter((entry) => entry.isDirectory() && entry.name !== '.git' && !ignored.has(entry.name))
      .map((entry) => scan(join(folder, entry.name), depth + 1)));
  };
  await scan(workspaceRoot, 0);
  return found;
}
