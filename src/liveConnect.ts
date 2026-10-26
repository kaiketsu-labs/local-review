import { open, realpath, unlink } from 'node:fs/promises';
import { readDescriptor, record } from './connection.js';
import { readPrivateJson, writePrivateJson } from './privateFiles.js';
import { isSessionId, readSessionBinding } from './sessionBinding.js';

/** Serialize explicit selection changes so a stale launch cannot clear a new owner. */
async function withSelectionLock(path: string, action: () => Promise<void>): Promise<void> {
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('Eine Verbindung wird gerade eingerichtet. Kurz danach erneut versuchen.'); });
  try { await action(); }
  finally {
    await lock.close();
    await unlink(lockPath);
  }
}

/** Bind the session selected by an explicit, locally invoked Claude skill. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--release') {
    const [, connectionPath, bindingPath, expected] = args;
    if (args.length !== 4 || connectionPath === undefined || bindingPath === undefined || !isSessionId(expected)) {
      throw new Error('Invalid Local Review launch handoff.');
    }
    const descriptor = await readDescriptor(connectionPath);
    if (await realpath(process.cwd()) !== await realpath(descriptor.workspaceRoot)) throw new Error('Das ausgewählte Projekt hat sich geändert.');
    await withSelectionLock(bindingPath, async () => {
      const binding = await readSessionBinding(bindingPath, descriptor.workspaceRoot);
      if (binding !== undefined && binding.sessionId !== expected) throw new Error('Eine andere Unterhaltung ist inzwischen ausgewählt. Den Verbindungsbefehl erneut kopieren.');
      if (binding !== undefined) await unlink(bindingPath);
    });
    return;
  }
  const fields = ['--connection', '--binding', '--ticket', '--session'];
  if (args.length !== 8 || fields.some((field, index) => args[index * 2] !== field)) throw new Error('Invalid Local Review connect command.');
  const [connectionPath, bindingPath, ticketPath, sessionId] = [args[1], args[3], args[5], args[7]];
  if (connectionPath === undefined || bindingPath === undefined || ticketPath === undefined || !isSessionId(sessionId)) {
    throw new Error('Claude did not supply a valid session identity.');
  }
  if (process.env['CLAUDE_CODE_SESSION_ID'] !== sessionId) {
    throw new Error('Diese Claude-Version liefert keine passende Sitzungskennung. Claude aktualisieren, dann erneut verbinden.');
  }
  const descriptor = await readDescriptor(connectionPath);
  if (await realpath(process.cwd()) !== await realpath(descriptor.workspaceRoot)) {
    throw new Error('Local Review gehört zu einem anderen Projekt. Im passenden VS-Code-Projekt verbinden.');
  }
  await withSelectionLock(bindingPath, async () => {
    const existing = await readSessionBinding(bindingPath, descriptor.workspaceRoot);
    if (existing?.sessionId === sessionId) {
      process.stdout.write('Local Review ist bereits mit dieser Unterhaltung verbunden.\n');
      return;
    }
    const ticket = record(await readPrivateJson(ticketPath));
    if (ticket?.version !== 1 || ticket.workspaceRoot !== descriptor.workspaceRoot
      || typeof ticket.expiresAt !== 'number' || !Number.isFinite(ticket.expiresAt) || ticket.expiresAt < Date.now()) {
      throw new Error('In VS Code „Laufende Unterhaltung verbinden“ wählen, dann diesen Befehl erneut ausführen.');
    }
    if (existing !== undefined) throw new Error('Eine andere Unterhaltung ist ausgewählt. Zuerst in VS Code die Verbindung wechseln.');
    await writePrivateJson(bindingPath, { version: 1, workspaceRoot: descriptor.workspaceRoot, sessionId });
    await unlink(ticketPath);
    process.stdout.write('Local Review mit dieser Unterhaltung verbunden. Feedback kommt automatisch; nur der Mensch löst Threads auf.\n');
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(`Local Review: ${error instanceof Error ? error.message : 'Verbindung fehlgeschlagen.'}\n`);
  process.exitCode = 1;
});
