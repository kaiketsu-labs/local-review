import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import type {
  BridgeState,
  CodeAnchor,
  ConnectionDescriptor,
  Disposable,
  ReviewBridge,
  ReviewEvent,
  ReviewMessage,
  ReviewStore,
  ReviewThread,
} from './contracts.js';
import {
  maximumConversationMessages,
  maximumConversationTextLength,
  maximumIdentifierLength,
  maximumPathLength,
  maximumReviewTextLength,
} from './limits.js';
import { parseAgentUpdate, ReviewStoreError } from './store.js';
import { readSessionBinding } from './sessionBinding.js';

const maximumBodyBytes = 256 * 1024;
const pollDurationMs = 20_000;
const connectionTimeoutMs = 45_000;

interface PendingPoll {
  readonly after: number;
  readonly sessionId: string | undefined;
  readonly response: ServerResponse;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly onClose: () => void;
}

/** Start an authenticated, workspace-scoped review bridge on a random loopback port. */
export async function createReviewBridge(store: ReviewStore, sessionBindingPath?: string): Promise<ReviewBridge> {
  const bridge = new LocalReviewBridge(store, sessionBindingPath);
  try {
    await bridge.listen();
    return bridge;
  } catch (error: unknown) {
    bridge.dispose();
    throw error;
  }
}

/** Serve local editor events without exposing an unauthenticated HTTP interface. */
class LocalReviewBridge implements ReviewBridge {
  readonly #store: ReviewStore;
  readonly #server: Server;
  readonly #token = randomBytes(32).toString('hex');
  readonly #listeners = new Set<() => void>();
  readonly #polls = new Set<PendingPoll>();
  readonly #storeSubscription: Disposable;
  #descriptor: ConnectionDescriptor | undefined;
  #state: BridgeState = Object.freeze({ connected: false, deliveryReady: false });
  #connectionTimer: ReturnType<typeof setTimeout> | undefined;
  #deliveryTimer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(store: ReviewStore, private readonly sessionBindingPath?: string) {
    this.#store = store;
    this.#server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        const status = error instanceof ReviewStoreError ? error.statusCode : 500;
        const message = error instanceof ReviewStoreError ? error.message : 'Local review request failed.';
        respond(response, status, { error: message });
      });
    });
    this.#server.requestTimeout = 15_000;
    this.#server.headersTimeout = 10_000;
    this.#server.keepAliveTimeout = 5_000;
    this.#server.on('error', () => { this.dispose(); });
    this.#storeSubscription = store.onChange(() => {
      for (const poll of this.#polls) {
        if (this.#eventsAfter(poll.after).length > 0) {
          this.#finishPoll(poll);
        }
      }
    });
  }

  get descriptor(): ConnectionDescriptor {
    if (this.#descriptor === undefined) {
      throw new Error('Review bridge has not started.');
    }
    return this.#descriptor;
  }

  get state(): BridgeState {
    return this.#state;
  }

  /** Bind exclusively to IPv4 loopback and publish its random-port descriptor. */
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { reject(error); };
      this.#server.once('error', onError);
      this.#server.listen(0, '127.0.0.1', () => {
        this.#server.off('error', onError);
        resolve();
      });
    });
    const address = this.#server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Review bridge did not obtain a loopback port.');
    }
    this.#descriptor = Object.freeze({
      version: 1,
      url: `http://127.0.0.1:${address.port}`,
      token: this.#token,
      workspaceRoot: this.#store.workspaceRoot,
    });
  }

  /** Subscribe to authenticated-client activity and connection expiry. */
  onChange(listener: () => void): Disposable {
    this.#listeners.add(listener);
    return { dispose: () => { this.#listeners.delete(listener); } };
  }

  /** Close pending polls, network connections, subscriptions, and expiry timers. */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#storeSubscription.dispose();
    clearTimeout(this.#connectionTimer);
    this.#connectionTimer = undefined;
    clearTimeout(this.#deliveryTimer);
    this.#deliveryTimer = undefined;
    for (const poll of this.#polls) {
      this.#finishPoll(poll, 503);
    }
    this.#server.close();
    this.#server.closeAllConnections();
    this.#state = Object.freeze({ connected: false, deliveryReady: false });
    this.#notify();
    this.#listeners.clear();
  }

  /** Authenticate before parsing routes or accepting potentially large request bodies. */
  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (this.#disposed) {
      request.resume();
      respond(response, 503, { error: 'Review bridge is shutting down.' });
      return;
    }
    if (!this.#authenticated(request)) {
      request.resume();
      respond(response, 401, { error: 'A valid review bridge token is required.' });
      return;
    }
    if (this.sessionBindingPath !== undefined) {
      const binding = await readSessionBinding(this.sessionBindingPath, this.#store.workspaceRoot);
      if (binding !== undefined && request.headers['x-local-review-session'] !== binding.sessionId) {
        request.resume();
        respond(response, 403, { error: 'Diese Claude-Unterhaltung ist nicht für dieses Review ausgewählt.' });
        return;
      }
    }
    if (request.headers.origin !== undefined) {
      request.resume();
      respond(response, 403, { error: 'Browser-origin requests are not supported.' });
      return;
    }
    this.#touch(request.headers['x-local-review-client']);
    const declaredLength = request.headers['content-length'];
    if (declaredLength !== undefined && Number(declaredLength) > maximumBodyBytes) {
      request.resume();
      respond(response, 413, { error: 'Review request exceeds the 256 KiB limit.' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/health') {
      request.resume();
      respond(response, 200, { workspaceRoot: this.#store.workspaceRoot });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/pending') {
      request.resume();
      respond(response, 200, this.#payload(this.#pendingEvents()));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/events') {
      request.resume();
      const after = parseCursor(url);
      const events = this.#eventsAfter(after);
      if (events.length > 0) {
        respond(response, 200, this.#payload(events));
      } else {
        const sessionId = request.headers['x-local-review-session'];
        this.#beginPoll(after, response, typeof sessionId === 'string' ? sessionId : undefined);
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/update') {
      const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') {
        request.resume();
        respond(response, 415, { error: 'Agent updates must use application/json.' });
        return;
      }
      const body = await readBody(request);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        throw new ReviewStoreError('Agent update body must contain valid JSON.');
      }
      if (this.sessionBindingPath !== undefined) {
        const binding = await readSessionBinding(this.sessionBindingPath, this.#store.workspaceRoot);
        if (binding !== undefined && request.headers['x-local-review-session'] !== binding.sessionId) {
          respond(response, 403, { error: 'Die ausgewählte Claude-Unterhaltung hat sich geändert.' });
          return;
        }
      }
      const thread = await this.#store.updateFromAgent(parseAgentUpdate(parsed));
      respond(response, 200, { thread: projectThread(thread) });
      return;
    }
    request.resume();
    respond(response, 404, { error: 'Review bridge route was not found.' });
  }

  /** Compare a bearer token without a data-dependent string comparison. */
  #authenticated(request: IncomingMessage): boolean {
    const authorization = request.headers.authorization;
    if (authorization === undefined || !authorization.startsWith('Bearer ')) {
      return false;
    }
    const supplied = Buffer.from(authorization.slice('Bearer '.length));
    const expected = Buffer.from(this.#token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  /** Track a feedback receiver separately from MCP tool activity and explicit event ACKs. */
  #touch(role: string | readonly string[] | undefined): void {
    clearTimeout(this.#connectionTimer);
    const receiver = role === 'watcher' || role === 'channel';
    this.#state = Object.freeze({
      connected: true, deliveryReady: receiver || this.#state.deliveryReady === true, lastSeenAt: Date.now(),
    });
    this.#connectionTimer = setTimeout(() => {
      this.#connectionTimer = undefined;
      clearTimeout(this.#deliveryTimer);
      this.#deliveryTimer = undefined;
      const lastSeenAt = this.#state.lastSeenAt;
      this.#state = Object.freeze(lastSeenAt === undefined
        ? { connected: false, deliveryReady: false }
        : { connected: false, deliveryReady: false, lastSeenAt });
      this.#notify();
    }, connectionTimeoutMs);
    this.#connectionTimer.unref();
    if (receiver) {
      clearTimeout(this.#deliveryTimer);
      this.#deliveryTimer = setTimeout(() => {
        this.#deliveryTimer = undefined;
        this.#state = Object.freeze({ ...this.#state, deliveryReady: false });
        this.#notify();
      }, connectionTimeoutMs);
      this.#deliveryTimer.unref();
    }
    this.#notify();
  }

  /** Return only undelivered work after the caller's monotonic cursor. */
  #eventsAfter(after: number): readonly ReviewEvent[] {
    return this.#store.pendingEvents.filter((event) => event.sequence > after);
  }

  /** Keep acknowledged but unfinished latest work visible for agent recovery. */
  #pendingEvents(): readonly ReviewEvent[] {
    const currentEvents = new Set<string>();
    const unfinished = new Set<string>();
    for (const thread of this.#store.threads) {
      if (!thread.resolved) {
        currentEvents.add(thread.latestEventId);
        if (thread.status === 'queued' || thread.status === 'received' || thread.status === 'working') {
          unfinished.add(thread.latestEventId);
        }
      }
    }
    return this.#store.events.filter((event) => currentEvents.has(event.id)
      && (!event.acknowledged || unfinished.has(event.id)));
  }

  /** Attach only relevant discussions without letting legacy text poison delivery. */
  #payload(events: readonly ReviewEvent[]): object {
    const threadIds = new Set(events.map((event) => event.threadId));
    return {
      events: events.map((event) => ({ ...event, text: projectText(event.text, maximumReviewTextLength), anchor: projectAnchor(event.anchor) })),
      threads: this.#store.threads.filter((thread) => !thread.resolved && threadIds.has(thread.id)).map(projectThread),
      workspaceRoot: this.#store.workspaceRoot,
    };
  }

  /** Wait for work without tying the connection to an editor event listener. */
  #beginPoll(after: number, response: ServerResponse, sessionId: string | undefined): void {
    const onClose = (): void => {
      clearTimeout(poll.timer);
      this.#polls.delete(poll);
    };
    const timer = setTimeout(() => { this.#finishPoll(poll); }, pollDurationMs);
    timer.unref();
    const poll: PendingPoll = { after, sessionId, response, timer, onClose };
    this.#polls.add(poll);
    response.once('close', onClose);
  }

  /** Complete a long poll exactly once, including shutdown and disconnect cleanup. */
  #finishPoll(poll: PendingPoll, status = 200): void {
    if (!this.#polls.delete(poll)) {
      return;
    }
    clearTimeout(poll.timer);
    poll.response.off('close', poll.onClose);
    if (status !== 200) {
      respond(poll.response, status, { error: 'Review bridge is shutting down.' });
      return;
    }
    void (async () => {
      try {
        const binding = this.sessionBindingPath === undefined ? undefined
          : await readSessionBinding(this.sessionBindingPath, this.#store.workspaceRoot);
        if (binding !== undefined && poll.sessionId !== binding.sessionId) {
          respond(poll.response, 403, { error: 'Die ausgewählte Claude-Unterhaltung hat sich geändert.' });
        } else {
          respond(poll.response, 200, this.#payload(this.#eventsAfter(poll.after)));
        }
      } catch { respond(poll.response, 503, { error: 'Die Claude-Verbindung muss erneut ausgewählt werden.' }); }
    })();
  }

  /** Keep lifecycle listeners isolated from local request processing. */
  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // Rendering failures cannot change the bridge's transport state.
      }
    }
  }
}

/** Bound legacy wire text while leaving the durable original untouched. */
function projectText(text: string, maximum: number): string {
  const escaped = text.replaceAll('\0', '\\0');
  if (escaped.length <= maximum) return escaped;
  const marker = '\n[Local Review: text truncated for delivery; the original remains in VS Code.]';
  return `${escaped.slice(0, Math.max(0, maximum - marker.length))}${marker}`;
}

/** Project old source captures using the same limits as new submissions. */
function projectAnchor(anchor: CodeAnchor): CodeAnchor {
  return {
    ...anchor,
    path: projectText(anchor.path, maximumPathLength),
    selectedText: projectText(anchor.selectedText, maximumReviewTextLength),
    contextBefore: projectText(anchor.contextBefore, maximumReviewTextLength),
    contextAfter: projectText(anchor.contextAfter, maximumReviewTextLength),
    documentHash: projectText(anchor.documentHash, maximumIdentifierLength),
    baseRevision: projectText(anchor.baseRevision, maximumPathLength),
  };
}

/** Keep recent context and mark any omitted history rather than silently losing it. */
function projectThread(thread: ReviewThread): ReviewThread {
  const messages: ReviewMessage[] = [];
  let remaining = maximumConversationTextLength;
  for (const message of thread.messages.slice(-maximumConversationMessages).toReversed()) {
    if (remaining < 100) break;
    const text = projectText(message.text, remaining);
    messages.unshift({ ...message, text });
    remaining -= text.length;
  }
  const first = messages[0];
  if (first !== undefined && messages.length < thread.messages.length) {
    const marker = '[Local Review: earlier conversation omitted from delivery; the original remains in VS Code.]\n';
    messages[0] = { ...first, text: projectText(`${marker}${first.text}`, maximumConversationTextLength) };
  }
  return { ...thread, anchor: projectAnchor(thread.anchor), messages };
}

/** Require a single nonnegative safe integer cursor. */
function parseCursor(url: URL): number {
  const values = url.searchParams.getAll('after');
  const value = values[0];
  if (values.length !== 1 || value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new ReviewStoreError('The after cursor must be a nonnegative integer.');
  }
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) {
    throw new ReviewStoreError('The after cursor is outside the supported range.');
  }
  return cursor;
}

/** Bound request memory and duration even for chunked or incomplete HTTP uploads. */
async function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      if (error === undefined) {
        resolve(Buffer.concat(chunks, size));
      } else {
        request.resume();
        reject(error);
      }
    };
    const onData = (chunk: unknown): void => {
      if (!(chunk instanceof Uint8Array)) {
        finish(new ReviewStoreError('Agent update must contain a UTF-8 JSON body.'));
        return;
      }
      size += chunk.byteLength;
      if (size > maximumBodyBytes) {
        finish(new ReviewStoreError('Agent update exceeds the 256 KiB limit.', 413));
      } else {
        chunks.push(chunk);
      }
    };
    const onEnd = (): void => { finish(); };
    const onError = (error: Error): void => { finish(error); };
    const onAborted = (): void => { finish(new ReviewStoreError('Agent update was aborted.', 400)); };
    const timer = setTimeout(() => {
      finish(new ReviewStoreError('Agent update upload timed out.', 408));
    }, 10_000);
    timer.unref();
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
  });
}

/** Send compact JSON only while a client response can still accept data. */
function respond(response: ServerResponse, status: number, body: object): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
