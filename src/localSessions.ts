import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { createReviewBridge } from './bridge.js';
import type { ReviewBridge, ReviewStore } from './contracts.js';
import { LocalReview, mainPageKey, toDisposable } from './localReview.js';
import { type ClaudeLauncher, createClaudeLauncher, prepareConnection } from './setup.js';
import { createReviewStore } from './store.js';

/** One checkout's local review: its comments, the Claude conversation that gets them, and its page. */
export interface LocalSession {
  readonly root: string;
  /** Where this checkout's review keeps its comments and connection, outside the repository. */
  readonly folder: string;
  readonly store: ReviewStore;
  readonly bridge: ReviewBridge;
  readonly launcher: ClaudeLauncher;
  readonly review: LocalReview;
}

const openedKey = 'pairReview.localCheckouts';

/**
 * Local review sessions by checkout folder, each with its own comments, read marks and Claude connection.
 * The window folder's session keeps the window's own storage; other checkouts get a folder of it, made when their page first opens.
 */
export class LocalSessions implements vscode.Disposable {
  readonly #sessions = new Map<string, Promise<LocalSession>>();
  readonly #changed = new vscode.EventEmitter<string>();
  /** Fires with a checkout's folder when its comments or connection change. */
  readonly onDidChange = this.#changed.event;
  readonly #disposables: vscode.Disposable[] = [this.#changed];

  constructor(
    private readonly context: vscode.ExtensionContext,
    /** The window's storage folder. */
    private readonly storagePath: string,
    /** The window folder's session, when that folder is a repository's top folder. */
    main: LocalSession | undefined,
    /** Finishes each session once it exists, such as letting its page find the branch's PR. */
    private readonly prepare: (session: LocalSession) => void = () => undefined,
  ) {
    if (main !== undefined) {
      this.#sessions.set(main.root, Promise.resolve(main));
      this.#watch(main);
      this.#disposables.push(main.review);
      prepare(main);
    }
  }

  /** The session of a checkout, made on first use and reopened after a reload. */
  async get(folder: string): Promise<LocalSession> {
    const root = await realpath(folder).catch(() => folder);
    let session = this.#sessions.get(root);
    if (session === undefined) {
      session = this.#create(root);
      this.#sessions.set(root, session);
      session.catch(() => { this.#sessions.delete(root); });
      const opened = this.context.workspaceState.get<readonly string[]>(openedKey, []);
      if (!opened.includes(root)) await this.context.workspaceState.update(openedKey, [...opened, root]);
    }
    return session;
  }

  /** A session that is already running, for counts that should not start one. */
  async find(folder: string): Promise<LocalSession | undefined> {
    const root = await realpath(folder).catch(() => folder);
    return this.#sessions.get(root)?.catch(() => undefined);
  }

  /** Start the sessions of checkouts opened before, so their Claude conversations reconnect. */
  async restore(exists: (root: string) => Promise<boolean>): Promise<void> {
    const opened = this.context.workspaceState.get<readonly string[]>(openedKey, []);
    const present = await Promise.all(opened.map(async (root) => await exists(root) ? root : undefined));
    const kept = present.filter((root) => root !== undefined);
    if (kept.length !== opened.length) await this.context.workspaceState.update(openedKey, kept);
    await Promise.all(kept.map((root) => this.get(root).catch(() => undefined)));
  }

  async #create(root: string): Promise<LocalSession> {
    const folder = join(this.storagePath, 'checkouts', createHash('sha256').update(root).digest('hex').slice(0, 16));
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const store = await createReviewStore(join(folder, 'review.json'), root);
    const bridge = await createReviewBridge(store, join(folder, 'selected-session.json'));
    try {
      await prepareConnection(this.context, bridge, folder);
    } catch (error: unknown) {
      bridge.dispose();
      throw error;
    }
    const launcher = createClaudeLauncher(this.context, bridge, folder);
    const review = new LocalReview(this.context, root, store, bridge, join(folder, 'local-review'), launcher, `${mainPageKey}:${root}`);
    const session = { root, folder, store, bridge, launcher, review };
    this.#watch(session);
    this.prepare(session);
    this.#disposables.push(review, launcher, bridge);
    this.#changed.fire(root);
    return session;
  }

  #watch({ root, store, bridge }: LocalSession): void {
    this.#disposables.push(toDisposable(store.onChange(() => { this.#changed.fire(root); })), toDisposable(bridge.onChange(() => { this.#changed.fire(root); })));
  }

  /** Save every session's comments before the window closes. */
  async flush(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map(async (session) => (await session.catch(() => undefined))?.store.flush()));
  }

  dispose(): void {
    for (const disposable of this.#disposables.splice(0)) disposable.dispose();
  }
}
