import { record } from './connection.js';
import { readPrivateJson } from './privateFiles.js';

/** Identify one explicitly selected conversation without reading its transcript. */
export interface SessionBinding {
  readonly version: 1;
  readonly workspaceRoot: string;
  readonly sessionId: string;
}

/** Claude session identifiers are UUIDs, including identifiers used by resume. */
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(value);
}

/** Fail closed on malformed ownership metadata or another project's binding. */
export async function readSessionBinding(path: string, workspaceRoot: string): Promise<SessionBinding | undefined> {
  const value = await readPrivateJson(path);
  if (value === undefined) return undefined;
  const data = record(value);
  if (data?.version !== 1 || data.workspaceRoot !== workspaceRoot || !isSessionId(data.sessionId)) {
    throw new Error('Die gespeicherte Claude-Verbindung ist ungültig. In VS Code erneut verbinden.');
  }
  return { version: 1, workspaceRoot, sessionId: data.sessionId };
}

/** Require the live plugin's own session to match the human's explicit selection. */
export async function ownsSession(path: string, workspaceRoot: string, sessionId: string | undefined): Promise<boolean> {
  return sessionId !== undefined && (await readSessionBinding(path, workspaceRoot))?.sessionId === sessionId;
}
