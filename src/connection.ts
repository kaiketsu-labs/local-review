import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { maximumIdentifierLength, maximumPathLength, maximumReviewTextLength } from './limits.js';
import type {
  AgentUpdate,
  CodeAnchor,
  ConnectionDescriptor,
  ReviewEvent,
  ReviewIntent,
  ReviewMessage,
  ReviewStatus,
  ReviewThread,
} from './contracts.js';

/** Validated bridge snapshot shared by hook and MCP transports. */
export interface ReviewBatch {
  readonly events: readonly ReviewEvent[];
  readonly threads: readonly ReviewThread[];
  readonly workspaceRoot: string;
}

/** An HTTP rejection with a stable status suitable for agent-facing feedback. */
export class BridgeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'BridgeError';
  }
}

/** A response that retrying the same bridge request cannot make deliverable. */
export class BridgeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeProtocolError';
  }
}

const maximumResponseLength = 10_000_000;
const requestTimeoutMs = 25_000;

/** Separate callable MCP tools from helpers that can wake Claude with new feedback. */
export type BridgeClientRole = 'tools' | 'watcher' | 'channel';

/** Narrow a JSON value without trusting data read from disk or HTTP. */
export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Check bounded text fields while preserving their original whitespace. */
export function isText(value: unknown, maximum = maximumReviewTextLength): value is string {
  return typeof value === 'string' && value.length <= maximum && !value.includes('\0');
}

/** Check identifiers without allowing empty or unbounded values. */
export function isIdentifier(value: unknown): value is string {
  return isText(value, maximumIdentifierLength) && value.trim().length > 0;
}

/** Validate the explicit action attached to a human comment. */
function isIntent(value: unknown): value is ReviewIntent {
  return value === 'ask' || value === 'implement' || value === 'summarize';
}

/** Validate states that can be displayed in a review thread. */
function isStatus(value: unknown): value is ReviewStatus {
  return value === 'queued' || value === 'received' || value === 'working'
    || value === 'answered' || value === 'ready';
}

/** Require actual positive integers for sequence and source line numbers. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Validate a workspace-relative path on either supported path separator. */
function isRelativePath(value: unknown): value is string {
  return isText(value, maximumPathLength) && value.trim().length > 0 && !isAbsolute(value)
    && !/^[A-Za-z]:[\\/]/u.test(value) && !value.startsWith('\\')
    && !value.split(/[\\/]/u).some((part) => part === '..');
}

/** Validate the immutable code context before it reaches Claude. */
function parseAnchor(value: unknown): CodeAnchor {
  const data = record(value);
  if (data === undefined || !isRelativePath(data.path)
    || !isPositiveInteger(data.startLine) || !isPositiveInteger(data.endLine)
    || data.endLine < data.startLine
    || !isText(data.selectedText) || !isText(data.contextBefore) || !isText(data.contextAfter)
    || !isIdentifier(data.documentHash) || !isText(data.baseRevision, maximumPathLength)
    || (data.side !== 'working' && data.side !== 'original')) {
    throw new BridgeProtocolError('The review bridge returned invalid source context.');
  }
  return {
    path: data.path,
    startLine: data.startLine,
    endLine: data.endLine,
    selectedText: data.selectedText,
    contextBefore: data.contextBefore,
    contextAfter: data.contextAfter,
    documentHash: data.documentHash,
    side: data.side,
    baseRevision: data.baseRevision,
  };
}

/** Validate an immutable pending review event. */
function parseEvent(value: unknown): ReviewEvent {
  const data = record(value);
  if (data === undefined || !isIdentifier(data.id) || !isPositiveInteger(data.sequence)
    || !isIdentifier(data.threadId) || !isIntent(data.intent) || !isText(data.text)
    || !isText(data.createdAt, 64) || !Number.isFinite(Date.parse(data.createdAt))
    || typeof data.acknowledged !== 'boolean') {
    throw new BridgeProtocolError('The review bridge returned an invalid event.');
  }
  return {
    id: data.id,
    sequence: data.sequence,
    threadId: data.threadId,
    intent: data.intent,
    text: data.text,
    anchor: parseAnchor(data.anchor),
    createdAt: data.createdAt,
    acknowledged: data.acknowledged,
  };
}

/** Validate a quoted conversation message. */
function parseMessage(value: unknown): ReviewMessage {
  const data = record(value);
  if (data === undefined || !isIdentifier(data.id)
    || (data.author !== 'human' && data.author !== 'claude') || !isText(data.text)
    || !isText(data.createdAt, 64) || !Number.isFinite(Date.parse(data.createdAt))
    || (data.eventId !== undefined && !isIdentifier(data.eventId))) {
    throw new BridgeProtocolError('The review bridge returned an invalid conversation message.');
  }
  return {
    id: data.id, author: data.author, text: data.text, createdAt: data.createdAt,
    ...(data.eventId === undefined ? {} : { eventId: data.eventId }),
  };
}

/** Validate the full native thread used as conversational context. */
export function parseThread(value: unknown): ReviewThread {
  const data = record(value);
  if (data === undefined || !isIdentifier(data.id) || !Array.isArray(data.messages)
    || data.messages.length > 10_000 || !isIntent(data.intent) || !isStatus(data.status)
    || typeof data.resolved !== 'boolean' || typeof data.outdated !== 'boolean'
    || !isIdentifier(data.latestEventId)) {
    throw new BridgeProtocolError('The review bridge returned an invalid review thread.');
  }
  return {
    id: data.id,
    anchor: parseAnchor(data.anchor),
    messages: data.messages.map((message: unknown) => parseMessage(message)),
    intent: data.intent,
    status: data.status,
    resolved: data.resolved,
    outdated: data.outdated,
    latestEventId: data.latestEventId,
  };
}

/** Validate a whole batch and optionally bind it to an expected workspace. */
export function readBatch(value: unknown, expectedWorkspaceRoot?: string): ReviewBatch {
  const data = record(value);
  if (data === undefined || !Array.isArray(data.events) || !Array.isArray(data.threads)
    || data.events.length > 10_000 || data.threads.length > 10_000
    || !isText(data.workspaceRoot, 4096) || !isAbsolute(data.workspaceRoot)
    || (expectedWorkspaceRoot !== undefined && data.workspaceRoot !== expectedWorkspaceRoot)) {
    throw new BridgeProtocolError('The review bridge returned an invalid review batch.');
  }
  return {
    events: data.events.map((event: unknown) => parseEvent(event)),
    threads: data.threads.map((thread: unknown) => parseThread(thread)),
    workspaceRoot: data.workspaceRoot,
  };
}

/** Read the extension's connection file and refuse non-loopback destinations. */
export async function readDescriptor(path: string): Promise<ConnectionDescriptor> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 65_536) {
    throw new Error('The review connection file is invalid. Run Local Review: Connect Claude Code again.');
  }
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  const data = record(raw);
  if (data === undefined || data.version !== 1 || !isText(data.url, 4096)
    || !isText(data.token, 512) || !/^[A-Za-z0-9_-]{16,512}$/u.test(data.token)
    || !isText(data.workspaceRoot, 4096) || !isAbsolute(data.workspaceRoot)) {
    throw new Error('The review connection file is invalid. Run Local Review: Connect Claude Code again.');
  }
  const url = new URL(data.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === ''
    || url.username !== '' || url.password !== '' || url.pathname !== '/'
    || url.search !== '' || url.hash !== '') {
    throw new Error('The review connection must use an authenticated HTTP endpoint on 127.0.0.1.');
  }
  return { version: 1, url: url.origin, token: data.token, workspaceRoot: data.workspaceRoot };
}

/** Authenticate local bridge requests for both hooks and MCP tools. */
export class BridgeClient {
  descriptor: ConnectionDescriptor;

  constructor(
    descriptor: ConnectionDescriptor,
    private readonly descriptorPath: string,
    private readonly signal: AbortSignal,
    private readonly role: BridgeClientRole = 'tools',
    private readonly sessionId: string | undefined = process.env['CLAUDE_CODE_SESSION_ID'],
  ) {
    this.descriptor = descriptor;
  }

  /** Reload an extension restart's port and token while preserving workspace identity. */
  async refresh(): Promise<boolean> {
    const next = await readDescriptor(this.descriptorPath);
    if (next.workspaceRoot !== this.descriptor.workspaceRoot) {
      throw new Error('The review connection changed workspaces. Reconnect Claude Code for this workspace.');
    }
    const changed = next.url !== this.descriptor.url || next.token !== this.descriptor.token;
    this.descriptor = next;
    return changed;
  }

  /** Make one request; mutations are never blindly retried after an ambiguous response. */
  async request(path: string, update?: AgentUpdate): Promise<unknown> {
    const endpoint = new URL(path, this.descriptor.url);
    if (endpoint.origin !== this.descriptor.url) {
      throw new Error('A review request cannot leave the authenticated local bridge.');
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const timer = setTimeout(abort, requestTimeoutMs);
    this.signal.addEventListener('abort', abort, { once: true });
    if (this.signal.aborted) controller.abort();
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.descriptor.token}`,
        Accept: 'application/json',
        'X-Local-Review-Client': this.role,
      };
      if (isIdentifier(this.sessionId)) headers['X-Local-Review-Session'] = this.sessionId;
      if (update !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(endpoint, {
        method: update === undefined ? 'GET' : 'POST',
        headers,
        signal: controller.signal,
        redirect: 'error',
        ...(update === undefined ? {} : { body: JSON.stringify(update) }),
      });
      const body = await response.text();
      if (body.length > maximumResponseLength) throw new BridgeProtocolError('The review bridge response is too large.');
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new BridgeProtocolError('The review bridge returned invalid JSON.');
      }
      if (!response.ok) {
        const error = record(payload)?.error;
        throw new BridgeError(response.status, isText(error, 1000) ? error : `Review bridge request failed (${response.status}).`);
      }
      return payload;
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener('abort', abort);
    }
  }
}
