import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeClient, BridgeProtocolError, readBatch, readDescriptor, record } from './connection.js';
import type { ReviewBatch } from './connection.js';
import { buildReviewBatchPrompt } from './eventPrompt.js';
import { createHookDeliveryLedger } from './hookDelivery.js';
import { ownsSession } from './sessionBinding.js';

/** Read the bounded JSON envelope supplied to a Claude command hook. */
async function readHookInput(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    size += chunk.length;
    if (size > 256 * 1024) throw new Error('Hook input exceeded the supported size.');
    chunks.push(chunk);
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const envelope = record(input);
  if (envelope === undefined) throw new Error('Hook input must be an object.');
  return envelope;
}

/** Treat a live or inaccessible process as owning its watcher lock. */
function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: unknown) {
    return record(error)?.code !== 'ESRCH';
  }
}

/** Keep one active wake-up watcher per workspace, even across Claude sessions. */
async function acquireLock(path: string, sessionId: string): Promise<string | undefined> {
  const owner = `owner-${process.pid}-${randomUUID()}.json`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error: unknown) {
      if (record(error)?.code !== 'EEXIST') throw error;
      try {
        const info = await stat(path);
        const owners = await readdir(path);
        if (owners.length === 0 && Date.now() - info.mtimeMs < 10_000) return undefined;
        const deadOwners: string[] = [];
        for (const filename of owners) {
          const match = /^owner-(\d+)-[a-f\d-]+\.json$/u.exec(filename);
          if (match?.[1] === undefined || processExists(Number(match[1]))) return undefined;
          deadOwners.push(filename);
        }
        await Promise.all(deadOwners.map(filename => unlink(join(path, filename)).catch((unlinkError: unknown) => {
          if (record(unlinkError)?.code !== 'ENOENT') throw unlinkError;
        })));
        await rmdir(path);
      } catch (readError: unknown) {
        const code = record(readError)?.code;
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw readError;
      }
      continue;
    }
    await writeFile(join(path, owner), JSON.stringify({ pid: process.pid, sessionId }), { flag: 'wx', mode: 0o600 });
    return owner;
  }
  return undefined;
}

/** Remove only a lock still owned by this hook process. */
async function releaseLock(path: string, owner: string): Promise<void> {
  try {
    await unlink(join(path, owner));
    await rmdir(path);
  } catch (error: unknown) {
    if (record(error)?.code !== 'ENOENT') process.stderr.write('Local Review: watcher lock cleanup failed.\n');
  }
}

/** Wait in the background and use asyncRewake's exit code to deliver human feedback. */
async function main(): Promise<void> {
  const argument = process.argv.indexOf('--connection');
  const connectionPath = argument < 0 ? undefined : process.argv[argument + 1];
  if (connectionPath === undefined) throw new Error('Missing review connection path.');
  const envelope = await readHookInput();
  if (envelope.agent_id !== undefined && envelope.agent_id !== null && envelope.agent_id !== '') return;
  const sessionId = envelope.session_id;
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0 || sessionId.length > 512 || sessionId.includes('\0')) {
    throw new Error('Claude did not supply a session identifier.');
  }
  const descriptor = await readDescriptor(connectionPath);
  const bindingPath = process.env['LOCAL_REVIEW_SESSION_BINDING'];
  if (bindingPath !== undefined && !await ownsSession(bindingPath, descriptor.workspaceRoot, sessionId)) return;
  const hash = createHash('sha256').update(descriptor.workspaceRoot).digest('hex').slice(0, 20);
  const lockPath = join(dirname(connectionPath), `watcher-${hash}.lock`);
  const owner = await acquireLock(lockPath, sessionId);
  if (owner === undefined) return;
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const bridge = new BridgeClient(descriptor, connectionPath, abort.signal, 'watcher', sessionId);
  let retryMs = 500;
  let recover = envelope.hook_event_name === 'SessionStart';
  try {
    const delivery = await createHookDeliveryLedger(connectionPath, descriptor.workspaceRoot, sessionId);
    let snapshot = true;
    let sequence = 0;
    while (!abort.signal.aborted) {
      if (bindingPath !== undefined && !await ownsSession(bindingPath, descriptor.workspaceRoot, sessionId)) return;
      let batch: ReviewBatch;
      try {
        batch = readBatch(await bridge.request(snapshot ? '/pending' : `/events?after=${sequence}`), descriptor.workspaceRoot);
        retryMs = 500;
      } catch (error: unknown) {
        if (error instanceof BridgeProtocolError) throw error;
        if (abort.signal.aborted) break;
        await delay(retryMs, undefined, { signal: abort.signal }).catch(() => {});
        retryMs = Math.min(retryMs * 2, 10_000);
        try { await bridge.refresh(); } catch { /* The extension may be reloading its connection file. */ }
        snapshot = true;
        continue;
      }
      if (abort.signal.aborted) break;
      if (bindingPath !== undefined && !await ownsSession(bindingPath, descriptor.workspaceRoot, sessionId)) return;
      if (!snapshot) {
        snapshot = true;
        continue;
      }
      sequence = batch.events.reduce((highest, event) => Math.max(highest, event.sequence), 0);
      const events = delivery.select(batch.events, recover);
      recover = false;
      if (events.length > 0) {
        const prompt = `${buildReviewBatchPrompt(events, batch.threads)}\n`;
        await new Promise<void>((resolveOutput, rejectOutput) => {
          process.stderr.write(prompt, (error) => {
            if (error === null || error === undefined) resolveOutput();
            else rejectOutput(error);
          });
        });
        await delivery.record(events);
        process.exitCode = 2;
        return;
      }
      await delivery.record([]);
      snapshot = false;
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await releaseLock(lockPath, owner);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`Local Review hook: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
