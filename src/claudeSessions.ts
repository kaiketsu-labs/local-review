import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { record } from './connection.js';
import { readPrivateJson } from './privateFiles.js';
import { isSessionId } from './sessionBinding.js';

/** Minimal, local metadata shown only after the human asks to choose a conversation. */
export interface ClaudeConversation {
  readonly id: string;
  readonly title: string;
  readonly modifiedAt: number;
  readonly branch: string;
  readonly running: boolean;
}

/** Keep conversation labels bounded and free of terminal or layout control characters. */
function label(value: unknown, maximum = 100): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, maximum) : '';
}

/** Read only a bounded beginning and ending, rather than loading a whole transcript. */
async function excerpt(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) return '';
    const size = Math.min(info.size, 16_384);
    const head = Buffer.alloc(size);
    await file.read(head, 0, size, 0);
    if (info.size <= size) return head.toString('utf8');
    const tail = Buffer.alloc(size);
    await file.read(tail, 0, size, info.size - size);
    return `${head.toString('utf8').split('\n').slice(0, -1).join('\n')}\n${tail.toString('utf8').split('\n').slice(1).join('\n')}`;
  } finally { await file.close(); }
}

/** Discover live UUIDs without opening their private messaging credentials or sockets. */
async function runningSessions(configRoot: string, workspaceRoots: ReadonlySet<string>): Promise<ReadonlySet<string>> {
  const directory = join(configRoot, 'sessions');
  const names = await readdir(directory).catch(() => [] as string[]);
  const running = new Set<string>();
  await Promise.all(names.filter(name => /^\d+\.json$/u.test(name)).slice(0, 256).map(async name => {
    try {
      const data = record(await readPrivateJson(join(directory, name)));
      if (typeof data?.cwd !== 'string' || !workspaceRoots.has(data.cwd) || !isSessionId(data.sessionId) || typeof data.pid !== 'number'
        || !Number.isSafeInteger(data.pid) || data.pid <= 0) return;
      process.kill(data.pid, 0);
      running.add(data.sessionId);
    } catch { /* Stale, inaccessible or malformed registrations are not live conversations. */ }
  }));
  return running;
}

/** List recent conversations for this exact project; Claude's picker remains the fallback. */
export async function listClaudeConversations(
  workspaceRoot: string, configRoot = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'),
): Promise<readonly ClaudeConversation[]> {
  const root = await realpath(workspaceRoot);
  const roots = new Set([root, resolve(workspaceRoot)]);
  const directories = await Promise.all([...roots].map(async projectRoot => {
    const directory = join(resolve(configRoot), 'projects', projectRoot.replace(/[^a-zA-Z0-9]/gu, '-'));
    const names = await readdir(directory).catch(() => [] as string[]);
    return names.filter(name => isSessionId(name.slice(0, -6)) && name.endsWith('.jsonl')).slice(0, 2_000)
      .map(name => ({ name, path: join(directory, name) }));
  }));
  const [files, running] = await Promise.all([
    Promise.all(directories.flat().map(async ({ name, path }) => {
      const info = await stat(path).catch(() => undefined);
      return info?.isFile() === true ? { id: name.slice(0, -6), path, modifiedAt: info.mtimeMs } : undefined;
    })),
    runningSessions(resolve(configRoot), roots),
  ]);
  const distinct = new Map(files.filter(file => file !== undefined).map(file => [file.id, file]));
  const recent = [...distinct.values()].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 20);
  const found = await Promise.all(recent.map(async (file): Promise<ClaudeConversation | undefined> => {
    try {
      let title = '';
      let automaticTitle = '';
      let firstPrompt = '';
      let branch = '';
      let belongs = false;
      for (const line of (await excerpt(file.path)).split('\n')) {
        let data: Record<string, unknown> | undefined;
        try { data = record(JSON.parse(line) as unknown); } catch { continue; }
        if (data === undefined || data['isSidechain'] === true) continue;
        if (typeof data['cwd'] === 'string' && roots.has(data['cwd'])) belongs = true;
        if (data['cwd'] !== undefined && (typeof data['cwd'] !== 'string' || !roots.has(data['cwd']))) continue;
        if (data['type'] === 'custom-title') title = label(data['customTitle']);
        if (data['type'] === 'ai-title') automaticTitle = label(data['aiTitle']);
        if (!automaticTitle && data['type'] === 'summary') automaticTitle = label(data['summary']);
        branch = label(data['gitBranch'], 60) || branch;
        if (!firstPrompt && data['type'] === 'user') {
          const content = record(data['message'])?.['content'];
          firstPrompt = label(typeof content === 'string' ? content : Array.isArray(content)
            ? content.map((part: unknown) => record(part)?.['text']).find((text: unknown) => typeof text === 'string') : '');
        }
      }
      if (!belongs) return undefined;
      return { id: file.id, title: title || automaticTitle || firstPrompt || `Unterhaltung ${file.id.slice(0, 8)}`,
        modifiedAt: file.modifiedAt, branch, running: running.has(file.id) };
    } catch { return undefined; }
  }));
  return found.filter(session => session !== undefined);
}
