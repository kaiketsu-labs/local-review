import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { afterEach } from 'node:test';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';
import type * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createReviewBridge } from '../src/bridge.js';
import { listClaudeConversations } from '../src/claudeSessions.js';
import { readBatch } from '../src/connection.js';
import { installLivePlugin, showLiveConnection } from '../src/liveSetup.js';
import { writePrivateJson } from '../src/privateFiles.js';
import { readSessionBinding } from '../src/sessionBinding.js';
import { createReviewStore } from '../src/store.js';
import { env, resetFakeEditor, resetFakeWindow, settle, window } from './fakes/vscode.js';

const firstSession = '11111111-1111-4111-8111-111111111111';
const otherSession = '22222222-2222-4222-8222-222222222222';
const execute = promisify(execFile);

afterEach(() => { resetFakeEditor(); resetFakeWindow(); });

/** Isolate session selection and real-process delivery from every existing Claude conversation. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'local-review-live-'));
  const bindingPath = join(root, 'selected-session.json');
  const store = await createReviewStore(join(root, 'review.json'), root);
  const bridge = await createReviewBridge(store, bindingPath);
  const connectionPath = join(root, 'connection.json');
  const ticketPath = join(root, 'connect-ticket.json');
  await writePrivateJson(connectionPath, bridge.descriptor);
  await writePrivateJson(ticketPath, { version: 1, workspaceRoot: root, expiresAt: Date.now() + 60_000 });
  t.after(async () => { bridge.dispose(); await store.flush(); await rm(root, { recursive: true, force: true }); });
  const headers = { Authorization: `Bearer ${bridge.descriptor.token}`, 'Content-Type': 'application/json' };
  return { root, bindingPath, store, bridge, connectionPath, ticketPath, headers };
}

/** Spawn the exact packaged connect helper as Claude's explicit skill would invoke it. */
async function bind(f: Awaited<ReturnType<typeof fixture>>, session = firstSession, runtimeSession = session) {
  return execute(process.execPath, [resolve('dist/live-connect.cjs'), '--connection', f.connectionPath,
    '--binding', f.bindingPath, '--ticket', f.ticketPath, '--session', session], {
    cwd: f.root, env: { ...process.env, CLAUDE_CODE_SESSION_ID: runtimeSession }, encoding: 'utf8', timeout: 5_000,
  });
}

test('explicit live connect binds one session privately, consumes the ticket and is idempotent', async t => {
  const f = await fixture(t);
  const result = await bind(f);
  assert.match(result.stdout, /mit dieser Unterhaltung verbunden/u);
  assert.equal((await readSessionBinding(f.bindingPath, f.root))?.sessionId, firstSession);
  assert.equal((await stat(f.bindingPath)).mode & 0o777, 0o600);
  assert.equal((await readdir(f.root)).includes('connect-ticket.json'), false);
  assert.match((await bind(f)).stdout, /bereits/u);
  await writePrivateJson(f.ticketPath, { version: 1, workspaceRoot: f.root, expiresAt: Date.now() + 60_000 });
  await assert.rejects(bind(f, otherSession), /andere Unterhaltung/u);
  assert.equal((await readSessionBinding(f.bindingPath, f.root))?.sessionId, firstSession);
});

test('live connect rejects missing identity, an expired ticket and another working directory', async t => {
  const f = await fixture(t);
  await assert.rejects(bind(f, firstSession, ''), /keine passende Sitzungskennung/u);
  await writePrivateJson(f.ticketPath, { version: 1, workspaceRoot: f.root, expiresAt: 0 });
  await assert.rejects(bind(f), /VS Code/u);
  assert.equal(await readSessionBinding(f.bindingPath, f.root), undefined);
  await writePrivateJson(f.ticketPath, { version: 1, workspaceRoot: f.root, expiresAt: Date.now() + 60_000 });
  const other = join(f.root, 'other-project'); await mkdir(other);
  await assert.rejects(execute(process.execPath, [resolve('dist/live-connect.cjs'), '--connection', f.connectionPath,
    '--binding', f.bindingPath, '--ticket', f.ticketPath, '--session', firstSession], {
    cwd: other, env: { ...process.env, CLAUDE_CODE_SESSION_ID: firstSession }, encoding: 'utf8', timeout: 5_000,
  }), /anderen Projekt/u);
  assert.equal(await readSessionBinding(f.bindingPath, f.root), undefined);
});

test('a copied launch releases only its expected owner and refuses a stale selection', async t => {
  const f = await fixture(t); await bind(f);
  const release = () => execute(process.execPath, [resolve('dist/live-connect.cjs'), '--release',
    f.connectionPath, f.bindingPath, firstSession], { cwd: f.root, encoding: 'utf8', timeout: 5_000 });
  await writePrivateJson(f.bindingPath, { version: 1, workspaceRoot: f.root, sessionId: otherSession });
  await assert.rejects(release(), /inzwischen ausgewählt/u);
  assert.equal((await readSessionBinding(f.bindingPath, f.root))?.sessionId, otherSession);
  await writePrivateJson(f.bindingPath, { version: 1, workspaceRoot: f.root, sessionId: firstSession });
  await writeFile(`${f.bindingPath}.lock`, '', { mode: 0o600 });
  await assert.rejects(release(), /gerade eingerichtet/u);
  assert.equal((await readSessionBinding(f.bindingPath, f.root))?.sessionId, firstSession);
  await rm(`${f.bindingPath}.lock`);
  await release();
  assert.equal(await readSessionBinding(f.bindingPath, f.root), undefined);
  await release();
});

test('the bridge refuses other or missing sessions without exposing work or reporting readiness', async t => {
  const f = await fixture(t); await bind(f);
  for (const sessionId of ['', otherSession]) {
    const response = await fetch(`${f.bridge.descriptor.url}/pending`, {
      headers: { ...f.headers, 'X-Local-Review-Session': sessionId, 'X-Local-Review-Client': 'watcher' },
    });
    assert.equal(response.status, 403);
    assert.equal(f.bridge.state.connected, false);
    assert.equal(f.bridge.state.deliveryReady, false);
  }
  const response = await fetch(`${f.bridge.descriptor.url}/pending`, { headers: { ...f.headers, 'X-Local-Review-Session': firstSession } });
  assert.equal(response.status, 200);
  assert.equal(readBatch(await response.json(), f.root).events.length, 0);
});

test('a poll opened before binding cannot leak the next comment to the previous receiver', async t => {
  const f = await fixture(t);
  const connected = new Promise<void>(done => { const sub = f.bridge.onChange(() => { sub.dispose(); done(); }); });
  const pending = fetch(`${f.bridge.descriptor.url}/events?after=0`, { headers: f.headers });
  await connected;
  await bind(f);
  await f.store.submit({ path: 'example.py', startLine: 1, endLine: 1, selectedText: 'value = 1', contextBefore: '',
    contextAfter: '', documentHash: 'hash', side: 'working', baseRevision: 'HEAD' }, 'Explain this.', 'ask');
  const response = await pending;
  assert.equal(response.status, 403);
  assert.doesNotMatch(await response.text(), /Explain this/u);
});

test('the live plugin rejects another MCP session and returns its reply only from the selected one', async t => {
  const f = await fixture(t); await bind(f);
  const thread = await f.store.submit({ path: 'example.py', startLine: 1, endLine: 1, selectedText: 'value = 1', contextBefore: '',
    contextAfter: '', documentHash: 'hash', side: 'working', baseRevision: 'HEAD' }, 'Explain this.', 'ask');
  for (const sessionId of [otherSession, firstSession]) {
    const client = new Client({ name: 'live-test', version: '1' }, { capabilities: {} });
    t.after(async () => { await client.close(); });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [resolve('dist/channel.cjs'), '--connection', f.connectionPath, '--no-push'], stderr: 'pipe',
      env: { LOCAL_REVIEW_SESSION_BINDING: f.bindingPath, CLAUDE_CODE_SESSION_ID: sessionId },
    });
    transport.stderr?.on('data', () => {});
    await client.connect(transport);
    const pending = await client.callTool({ name: 'list_pending_reviews', arguments: {} });
    assert.equal(pending.isError === true, sessionId !== firstSession);
    const reply = await client.callTool({ name: 'reply_to_review', arguments: { event_id: thread.latestEventId, text: 'A selected-session answer.', status: 'answered' } });
    assert.equal(reply.isError === true, sessionId !== firstSession);
    assert.equal(f.store.threads[0]?.messages.length, sessionId === firstSession ? 2 : 1);
    await client.close();
  }
});

test('only the selected hook wakes for feedback and leaves acknowledgment to Claude tools', async t => {
  const f = await fixture(t); await bind(f);
  const thread = await f.store.submit({ path: 'example.py', startLine: 1, endLine: 1, selectedText: 'value = 1', contextBefore: '',
    contextAfter: '', documentHash: 'hash', side: 'working', baseRevision: 'HEAD' }, 'Explain this.', 'ask');
  for (const sessionId of [otherSession, firstSession]) {
    const child = spawn(process.execPath, [resolve('dist/hook-waiter.cjs'), '--connection', f.connectionPath], {
      env: { ...process.env, LOCAL_REVIEW_SESSION_BINDING: f.bindingPath }, stdio: 'pipe',
    });
    let output = ''; child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stdin.end(JSON.stringify({ session_id: sessionId, hook_event_name: 'Stop' }));
    const code = await new Promise<number | null>((done, reject) => { child.on('error', reject); child.on('exit', done); });
    assert.equal(code, sessionId === firstSession ? 2 : 0);
    assert.equal(output.includes(thread.latestEventId), sessionId === firstSession);
    assert.equal(f.store.events[0]?.acknowledged, false);
  }
});

test('malformed ownership data fails closed instead of reverting to unrestricted bridge access', async t => {
  const f = await fixture(t);
  await writePrivateJson(f.bindingPath, { version: 1, workspaceRoot: '/another-project', sessionId: firstSession });
  const response = await fetch(`${f.bridge.descriptor.url}/pending`, { headers: f.headers });
  assert.equal(response.status, 500);
  assert.equal(f.bridge.state.connected, false);
});

test('live setup generates a local plugin with session guards and uses only local-scoped CLI operations', async t => {
  const f = await fixture(t);
  const calls = join(f.root, 'calls.jsonl');
  const executable = join(f.root, "Claude's cli");
  await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]==='--version'){console.log('2.1.280 (Claude Code)');}else{fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');}\n`, { mode: 0o700 });
  const context = { extensionPath: resolve('.'), subscriptions: [] } as unknown as vscode.ExtensionContext;
  await installLivePlugin(context, f.bridge, f.root, executable, process.execPath);
  const plugin = join(f.root, 'live', 'marketplace', 'plugins', 'local-review');
  const mcp = JSON.parse(await readFile(join(plugin, '.mcp.json'), 'utf8')) as { mcpServers: { 'local-review': { env: Record<string, string>; args: string[] } } };
  assert.equal(mcp.mcpServers['local-review'].env['LOCAL_REVIEW_SESSION_BINDING'], f.bindingPath);
  assert.ok(mcp.mcpServers['local-review'].args.includes('--no-push'));
  assert.match(await readFile(join(plugin, 'skills', 'connect', 'SKILL.md'), 'utf8'), /\$\{CLAUDE_SESSION_ID\}/u);
  const commands = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
  assert.deepEqual(commands.map(args => args.slice(-2)), [['--scope', 'local'], ['--scope', 'local']]);
  assert.equal(await readSessionBinding(f.bindingPath, f.root), undefined);
  assert.equal(window.terminals.length, 0);
});

test('the live setup view copies only its two known commands and does not run terminal input', async t => {
  const f = await fixture(t);
  const panel = showLiveConnection(f.bridge); t.after(() => panel.dispose());
  const fake = window.panels.at(-1); assert.ok(fake);
  fake.receive({ type: 'copy', command: 'reload' }); await settle();
  fake.receive({ type: 'copy', command: 'connect' }); await settle();
  fake.receive({ type: 'copy', command: 'arbitrary-command' }); await settle();
  assert.deepEqual(env.clipboard.writes, ['/reload-plugins --force', '/local-review:connect']);
  assert.equal(window.terminals.length, 0);
  assert.match(fake.webview.html, /aria-live="polite"/u);
});

test('older Claude builds are rejected before creating or installing a live plugin', async t => {
  const f = await fixture(t);
  const executable = join(f.root, 'old-claude');
  await writeFile(executable, `#!${process.execPath}\nconsole.log('2.1.70 (Claude Code)');\n`, { mode: 0o700 });
  const context = { extensionPath: resolve('.'), subscriptions: [] } as unknown as vscode.ExtensionContext;
  await assert.rejects(installLivePlugin(context, f.bridge, f.root, executable, process.execPath), /gefunden: 2\.1\.70/u);
  assert.equal((await readdir(f.root)).includes('live'), false);
});

test('the saved picker reads bounded metadata for this exact project and distinguishes a running session', async t => {
  const f = await fixture(t);
  const config = join(f.root, 'claude-config');
  const project = join(config, 'projects', f.root.replace(/[^a-zA-Z0-9]/gu, '-'));
  await mkdir(project, { recursive: true }); await mkdir(join(config, 'sessions'));
  await writePrivateJson(join(config, 'sessions', `${process.pid}.json`), { pid: process.pid, sessionId: firstSession, cwd: f.root });
  await writeFile(join(project, `${firstSession}.jsonl`), [
    JSON.stringify({ type: 'user', cwd: f.root, gitBranch: 'feature/retry', message: { content: 'Improve the retry function' } }),
    JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(100_000) } }),
    JSON.stringify({ type: 'custom-title', customTitle: 'Retry improvements' }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Automatic title must not replace the custom name' }),
  ].join('\n'));
  await writeFile(join(project, `${otherSession}.jsonl`), JSON.stringify({ type: 'user', cwd: '/another-project', message: { content: 'Do not show this' } }));
  const sessions = await listClaudeConversations(f.root, config);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.id, firstSession);
  assert.equal(sessions[0]?.title, 'Retry improvements');
  assert.equal(sessions[0]?.running, true);
  assert.equal(sessions[0]?.branch, 'feature/retry');
  await writeFile(join(project, `${firstSession}.jsonl`), [
    JSON.stringify({ type: 'user', cwd: f.root, message: { content: 'Long original prompt' } }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Short generated title' }),
  ].join('\n'));
  assert.equal((await listClaudeConversations(f.root, config))[0]?.title, 'Short generated title');
});
