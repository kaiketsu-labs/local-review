import type * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { afterEach } from 'node:test';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';

import type { ReviewBridge } from '../src/contracts.js';
import { prepareConnection, registerClaudeLauncher } from '../src/setup.js';
import { writePrivateJson } from '../src/privateFiles.js';
import { readSessionBinding } from '../src/sessionBinding.js';
import { commands, env, FakeTerminal, resetFakeEditor, resetFakeWindow, terminalEvents, window, workspace } from './fakes/vscode.js';

const registrations: vscode.Disposable[] = [];

afterEach(() => {
  for (const registration of registrations.splice(0)) registration.dispose();
  resetFakeEditor();
  resetFakeWindow();
});

/** Provide a valid private connection without starting or interrupting a real Claude session. */
function bridge(workspaceRoot: string, connected = true, deliveryReady = connected): ReviewBridge {
  return {
    descriptor: { version: 1, url: 'http://127.0.0.1:32123', token: 'test-private-token', workspaceRoot },
    state: { connected, deliveryReady },
    onChange: () => ({ dispose() {} }),
    dispose() {},
  };
}

/** Isolate generated integration files from reviewed repositories and user settings. */
async function fixture(t: TestContext): Promise<{ root: string; context: vscode.ExtensionContext }> {
  const root = await mkdtemp(join(tmpdir(), 'local-review-setup-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { root, context: { extensionPath: '/installed/local-review' } as vscode.ExtensionContext };
}

/** Report command completion while preserving the terminal's idle shell and identity. */
function endSession(terminal: FakeTerminal): void {
  terminalEvents.ended.fire({ terminal } as unknown as vscode.TerminalShellExecutionEndEvent);
}

test('reuses this project\'s latest managed Claude terminal after the extension is recreated', async (t) => {
  const { root, context } = await fixture(t);
  const earlier = new FakeTerminal({ name: 'Claude · Local Review', cwd: root });
  const terminal = new FakeTerminal({ name: 'Claude · Local Review', cwd: root });
  Object.defineProperty(terminal, 'name', { value: 'Claude — current task' });
  window.terminals.push(earlier, terminal);
  const initial = registerClaudeLauncher(context, bridge(root), root);
  initial.dispose();
  registrations.push(registerClaudeLauncher(context, bridge(root), root));

  await commands.executeCommand('localReview.startClaude');

  assert.equal(window.terminals.length, 2);
  assert.equal(earlier.showCalls, 0);
  assert.equal(earlier.disposed, false);
  assert.equal(terminal.showCalls, 1);
  assert.equal(terminal.disposed, false);
  assert.deepEqual(terminal.sendTextCalls, []);
  assert.deepEqual(window.quickPicks[0]?.map((item) => item.label), ['Terminal anzeigen', 'Unterhaltung wechseln']);
  assert.match(window.quickPicks[0]?.[1]?.description ?? '', /beende|schließen/u);
  assert.deepEqual(await readdir(root), []);
});

test('does not adopt another project\'s terminal or dispose it when connection setup is cancelled', async (t) => {
  const { root, context } = await fixture(t);
  const terminal = new FakeTerminal({ name: 'Claude · Local Review', cwd: join(root, 'another-project') });
  window.terminals.push(terminal);
  window.quickPickIndex = undefined;
  registrations.push(registerClaudeLauncher(context, bridge(root, false), root));

  await commands.executeCommand('localReview.startClaude');

  assert.equal(terminal.showCalls, 0);
  assert.equal(terminal.disposed, false);
  assert.deepEqual(window.quickPicks[0]?.map((item) => item.label), ['Unterhaltung auswählen', 'Neue Unterhaltung', 'Laufende Unterhaltung verbinden']);
  assert.deepEqual(await readdir(root), []);
});

test('an active external review receiver prevents launching a competing managed session', async (t) => {
  const { root, context } = await fixture(t);
  const external = new FakeTerminal({ name: 'Claude', cwd: root });
  window.terminals.push(external);
  registrations.push(registerClaudeLauncher(context, bridge(root), root));

  await commands.executeCommand('localReview.startClaude');

  assert.match(window.information[0] ?? '', /Review-Verbindung.*\/exit.*45 Sekunden/u);
  assert.deepEqual(window.quickPicks, []);
  assert.equal(window.terminals.length, 1);
  assert.equal(external.showCalls, 0);
  assert.equal(external.disposed, false);
  assert.deepEqual(external.sendTextCalls, []);
  assert.deepEqual(await readdir(root), []);
});

test('an ended managed session cannot authorize takeover or be rediscovered as the active receiver', async (t) => {
  const { root, context } = await fixture(t);
  const terminal = new FakeTerminal({ name: 'Claude · Local Review', cwd: root });
  const state = { connected: true, deliveryReady: true };
  window.terminals.push(terminal);
  registrations.push(registerClaudeLauncher(context, { ...bridge(root), state }, root));
  endSession(terminal);

  await commands.executeCommand('localReview.startClaude');
  await commands.executeCommand('localReview.startClaude');

  assert.equal(window.information.length, 2);
  assert.equal(window.quickPicks.length, 0);
  assert.equal(window.terminals.length, 1);
  assert.equal(terminal.disposed, false);
  assert.equal(terminal.showCalls, 0);
  assert.deepEqual(terminal.sendTextCalls, []);
  assert.deepEqual(await readdir(root), []);

  state.deliveryReady = false;
  window.quickPickIndex = undefined;
  await commands.executeCommand('localReview.startClaude');

  assert.deepEqual(window.quickPicks[0]?.map((item) => item.label), ['Unterhaltung auswählen', 'Neue Unterhaltung', 'Laufende Unterhaltung verbinden']);
  assert.equal(terminal.disposed, false);
  assert.deepEqual(await readdir(root), []);
});

test('a receiver connecting while the conversation picker is open prevents a competing launch', async (t) => {
  const { root, context } = await fixture(t);
  const state = { connected: false, deliveryReady: false };
  window.beforeQuickPick = () => { state.connected = true; state.deliveryReady = true; };
  registrations.push(registerClaudeLauncher(context, { ...bridge(root, false), state }, root));

  await commands.executeCommand('localReview.startClaude');

  assert.equal(window.quickPicks.length, 1);
  assert.match(window.information[0] ?? '', /Review-Verbindung.*aktiv oder wird getrennt/u);
  assert.equal(window.terminals.length, 0);
  assert.deepEqual(await readdir(root), []);
});

test('a receiver taking over after managed command completion during setup prevents disposal and launch', async (t) => {
  const { root, context } = await fixture(t);
  const terminal = new FakeTerminal({ name: 'Claude · Local Review', cwd: root });
  const state = { connected: true, deliveryReady: false };
  window.terminals.push(terminal);
  workspace.configurationValues.set('localReview.claudePath', process.execPath);
  workspace.configurationValues.set('localReview.nodePath', process.execPath);
  const getConfiguration = workspace.getConfiguration.bind(workspace);
  let configurationReads = 0;
  t.mock.method(workspace, 'getConfiguration', (section: string) => {
    configurationReads += 1;
    if (configurationReads === 2) {
      endSession(terminal);
      state.deliveryReady = true;
    }
    return getConfiguration(section);
  });
  registrations.push(registerClaudeLauncher(context, { ...bridge(root, false), state }, root));

  await commands.executeCommand('localReview.startClaude');

  assert.equal(configurationReads, 2);
  assert.deepEqual(window.errors, []);
  assert.match(window.information[0] ?? '', /Review-Verbindung.*aktiv oder wird getrennt/u);
  assert.equal(window.terminals.length, 1);
  assert.equal(terminal.disposed, false);
  assert.deepEqual(terminal.sendTextCalls, []);
});

test('finds a managed terminal restored after extension activation without launching a duplicate', async (t) => {
  const { root, context } = await fixture(t);
  registrations.push(registerClaudeLauncher(context, bridge(root), root));
  const terminal = new FakeTerminal({ name: 'Claude · Local Review', cwd: root });
  window.terminals.push(terminal);

  await commands.executeCommand('localReview.startClaude');

  assert.equal(window.terminals.length, 1);
  assert.equal(terminal.showCalls, 1);
  assert.deepEqual(terminal.sendTextCalls, []);
});

test('cancelling reconnect keeps the recovered conversation and performs no runtime writes', async (t) => {
  const { root, context } = await fixture(t);
  const terminal = new FakeTerminal({ name: 'Claude · Local Review', cwd: root });
  window.terminals.push(terminal);
  window.quickPickIndex = undefined;
  registrations.push(registerClaudeLauncher(context, bridge(root, false), root));

  await commands.executeCommand('localReview.startClaude');

  assert.equal(window.terminals.length, 1);
  assert.equal(terminal.disposed, false);
  assert.deepEqual(terminal.sendTextCalls, []);
  assert.deepEqual(await readdir(root), []);
});

for (const ready of [true, false]) {
  test(`cancelling the conversation picker preserves a ${ready ? 'ready' : 'paused'} managed session`, async (t) => {
    const { root, context } = await fixture(t);
    const terminal = new FakeTerminal({ name: 'Claude · Local Review', cwd: root });
    window.terminals.push(terminal);
    window.quickPickIndexes.push(ready ? 1 : 0, undefined);
    registrations.push(registerClaudeLauncher(context, bridge(root, true, ready), root));

    await commands.executeCommand('localReview.startClaude');

    assert.equal(window.quickPicks.length, 2);
    assert.equal(window.terminals.length, 1);
    assert.equal(terminal.disposed, false);
    assert.deepEqual(terminal.sendTextCalls, []);
    assert.deepEqual(await readdir(root), []);
  });
}

test('a tool-only connection offers recovery before reopening the existing inactive delivery terminal', async (t) => {
  const { root, context } = await fixture(t);
  const terminal = new FakeTerminal({ name: 'Claude · Local Review', cwd: root });
  window.terminals.push(terminal);
  window.quickPickIndex = undefined;
  registrations.push(registerClaudeLauncher(context, bridge(root, true, false), root));

  await commands.executeCommand('localReview.startClaude');

  assert.deepEqual(window.quickPicks[0]?.map((item) => item.label), ['Verbindung neu starten', 'Terminal anzeigen']);
  assert.equal(terminal.disposed, false);
  assert.deepEqual(terminal.sendTextCalls, []);
});

test('a failed replacement setup preserves the existing Claude conversation', async (t) => {
  const { root, context } = await fixture(t);
  const terminal = new FakeTerminal({ name: 'Claude · Local Review', cwd: root });
  window.terminals.push(terminal);
  workspace.configurationValues.set('localReview.claudePath', join(root, 'missing-claude'));
  registrations.push(registerClaudeLauncher(context, bridge(root, false), root));

  await commands.executeCommand('localReview.startClaude');

  assert.equal(window.terminals.length, 1);
  assert.equal(terminal.disposed, false);
  assert.deepEqual(terminal.sendTextCalls, []);
  assert.match(window.errors[0] ?? '', /wurde nicht gefunden/u);
  assert.deepEqual(await readdir(root), []);
});

for (const resume of [true, false]) {
  test(`starts ${resume ? 'a resumed' : 'a new'} conversation with private integration arguments in the correct project`, async (t) => {
    const { root, context } = await fixture(t);
    const settings = '{"env":{"ANTHROPIC_MODEL":"project-model"},"permissions":{"deny":["Bash(rm *)"]}}\n';
    const mcp = '{"mcpServers":{"existing":{"command":"project-tool"}}}\n';
    await mkdir(join(root, '.claude'));
    await writeFile(join(root, '.claude', 'settings.local.json'), settings);
    await writeFile(join(root, '.mcp.json'), mcp);
    workspace.configurationValues.set('localReview.claudePath', process.execPath);
    workspace.configurationValues.set('localReview.nodePath', process.execPath);
    window.quickPickIndex = resume ? 0 : 1;
    registrations.push(registerClaudeLauncher(context, bridge(root, false), root));

    await commands.executeCommand('localReview.startClaude');

    assert.deepEqual(window.errors, []);
    assert.equal(window.terminals.length, 1);
    const terminal = window.terminals[0];
    assert.ok(terminal);
    assert.equal(terminal.creationOptions.cwd, root);
    assert.equal(terminal.showCalls, 1);
    assert.equal(terminal.sendTextCalls.length, 1);
    const command = terminal.sendTextCalls[0]?.text ?? '';
    assert.ok(command.includes(`'--mcp-config' '${join(root, 'mcp.json')}'`));
    assert.ok(command.includes(`'--settings' '${join(root, 'hooks.json')}'`));
    assert.equal(command.includes("'--resume'"), resume);
    assert.equal(command.includes("'--continue'"), false);
    assert.equal(command.includes('dangerously-load-development-channels'), false);
    assert.equal(command.includes('--strict-mcp-config'), false);
    assert.equal(command.includes('--dangerously-skip-permissions'), false);
    assert.equal(command.includes('--permission-mode'), false);
    assert.equal(command.includes('--setting-sources'), false);
    assert.deepEqual(workspace.configurationWrites, []);
    assert.equal(await readFile(join(root, '.claude', 'settings.local.json'), 'utf8'), settings);
    assert.equal(await readFile(join(root, '.mcp.json'), 'utf8'), mcp);
  });
}

test('switching the connected managed conversation starts the selected new session explicitly', async (t) => {
  const { root, context } = await fixture(t);
  const terminal = new FakeTerminal({ name: 'Claude · Local Review', cwd: root });
  window.terminals.push(terminal);
  window.quickPickIndexes.push(1, 1);
  workspace.configurationValues.set('localReview.claudePath', process.execPath);
  workspace.configurationValues.set('localReview.nodePath', process.execPath);
  registrations.push(registerClaudeLauncher(context, bridge(root), root));

  await commands.executeCommand('localReview.startClaude');

  assert.equal(terminal.disposed, true);
  assert.deepEqual(terminal.sendTextCalls, []);
  assert.equal(window.terminals.length, 2);
  const replacement = window.terminals[1];
  assert.equal(replacement?.creationOptions.cwd, root);
  assert.equal(replacement?.showCalls, 1);
  assert.equal(replacement?.sendTextCalls.length, 1);
  assert.doesNotMatch(replacement?.sendTextCalls[0]?.text ?? '', /--resume|--continue/u);
});

for (const resume of [true, false]) {
  test(`copies ${resume ? 'a resume' : 'a fresh session'} command without touching managed or external terminals`, async (t) => {
    const { root, context } = await fixture(t);
    const terminal = new FakeTerminal({ name: 'Claude · Local Review', cwd: root });
    const unrelated = new FakeTerminal({ name: 'Claude', cwd: root });
    window.terminals.push(terminal, unrelated);
    window.quickPickIndex = resume ? 0 : 1;
    workspace.configurationValues.set('localReview.claudePath', process.execPath);
    workspace.configurationValues.set('localReview.nodePath', process.execPath);
    registrations.push(registerClaudeLauncher(context, bridge(root), root));

    await commands.executeCommand('localReview.copyClaudeCommand');

    assert.deepEqual(window.errors, []);
    assert.equal(env.clipboard.writes.length, 1);
    const command = env.clipboard.writes[0] ?? '';
    assert.ok(command.startsWith(`cd '${root}' && `));
    assert.ok(command.includes(`'--mcp-config' '${join(root, 'mcp.json')}'`));
    assert.ok(command.includes(`'--settings' '${join(root, 'hooks.json')}'`));
    assert.equal(command.includes("'--resume'"), resume);
    assert.equal(command.includes('--continue'), false);
    assert.equal(command.includes('--strict-mcp-config'), false);
    assert.equal(command.includes('--dangerously-skip-permissions'), false);
    assert.equal(window.terminals.length, 2);
    for (const existing of [terminal, unrelated]) {
      assert.equal(existing.disposed, false);
      assert.equal(existing.showCalls, 0);
      assert.deepEqual(existing.sendTextCalls, []);
    }
  });
}

test('cancelling an external command preserves the clipboard, terminal, and runtime files', async (t) => {
  const { root, context } = await fixture(t);
  const terminal = new FakeTerminal({ name: 'Claude · Local Review', cwd: root });
  window.terminals.push(terminal);
  window.quickPickIndex = undefined;
  registrations.push(registerClaudeLauncher(context, bridge(root), root));

  await commands.executeCommand('localReview.copyClaudeCommand');

  assert.deepEqual(env.clipboard.writes, []);
  assert.equal(window.terminals.length, 1);
  assert.equal(terminal.disposed, false);
  assert.deepEqual(terminal.sendTextCalls, []);
  assert.deepEqual(await readdir(root), []);
});

test('copying a new-session command preserves the live selection until the command is executed', async t => {
  const { root } = await fixture(t);
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const bindingPath = join(root, 'selected-session.json');
  await writePrivateJson(bindingPath, { version: 1, workspaceRoot: root, sessionId });
  const executable = join(root, 'claude-fixture');
  await writeFile(executable, `#!${process.execPath}\nconsole.log('new-session-started');\n`, { mode: 0o700 });
  const context = { extensionPath: resolve('.') } as vscode.ExtensionContext;
  workspace.configurationValues.set('localReview.claudePath', executable);
  workspace.configurationValues.set('localReview.nodePath', process.execPath);
  window.quickPickIndex = 1;
  registrations.push(registerClaudeLauncher(context, bridge(root, false), root));
  await commands.executeCommand('localReview.copyClaudeCommand');
  assert.deepEqual(window.errors, []);
  assert.equal((await readSessionBinding(bindingPath, root))?.sessionId, sessionId);
  const command = env.clipboard.writes[0]; assert.ok(command);
  const result = await promisify(execFile)('/bin/sh', ['-c', command], { cwd: root, encoding: 'utf8', timeout: 5_000 });
  assert.equal(result.stdout.trim(), 'new-session-started');
  assert.equal(await readSessionBinding(bindingPath, root), undefined);
});

test('failed external command setup leaves the clipboard and active conversation untouched', async (t) => {
  const { root, context } = await fixture(t);
  const terminal = new FakeTerminal({ name: 'Claude · Local Review', cwd: root });
  window.terminals.push(terminal);
  workspace.configurationValues.set('localReview.claudePath', join(root, 'missing-claude'));
  registrations.push(registerClaudeLauncher(context, bridge(root), root));

  await commands.executeCommand('localReview.copyClaudeCommand');

  assert.match(window.errors[0] ?? '', /wurde nicht gefunden/u);
  assert.deepEqual(env.clipboard.writes, []);
  assert.equal(terminal.disposed, false);
  assert.deepEqual(terminal.sendTextCalls, []);
  assert.deepEqual(await readdir(root), []);
});

test('the copied command preserves shell-special paths as literal arguments and selects the exact project', async (t) => {
  const { root, context } = await fixture(t);
  const project = join(root, "review's $(touch unintended) `touch backtick` & space");
  const storage = join(root, 'private config');
  const executable = join(root, "Claude's $(touch executable-injection)");
  await mkdir(project);
  await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n`, { mode: 0o700 });
  workspace.configurationValues.set('localReview.claudePath', executable);
  workspace.configurationValues.set('localReview.nodePath', process.execPath);
  registrations.push(registerClaudeLauncher(context, bridge(project, false), storage));

  await commands.executeCommand('localReview.copyClaudeCommand');

  assert.deepEqual(window.errors, []);
  assert.equal(env.clipboard.writes.length, 1);
  const command = env.clipboard.writes[0];
  assert.ok(command);
  const result = await promisify(execFile)('/bin/sh', ['-c', command], { cwd: root, encoding: 'utf8', timeout: 5_000 });
  assert.deepEqual(JSON.parse(result.stdout), {
    cwd: await realpath(project),
    args: ['--mcp-config', join(storage, 'mcp.json'), '--settings', join(storage, 'hooks.json'), '--resume'],
  });
  assert.equal(result.stderr, '');
  assert.deepEqual(await readdir(project), []);
  assert.deepEqual((await readdir(root)).sort(), [executable.slice(root.length + 1), 'private config', project.slice(root.length + 1)].sort());
  assert.equal(window.terminals.length, 0);
});

test('rewriting private integration files replaces permissive old files and preserves complete JSON for readers', async (t) => {
  const { root, context } = await fixture(t);
  const source = bridge(root);
  const prepared = await prepareConnection(context, source, root, process.execPath);
  const connectionPath = join(root, 'connection.json');
  const files = [connectionPath, prepared.mcpPath, prepared.hooksPath];
  await Promise.all(files.map((path) => chmod(path, 0o644)));
  let complete = false;
  let reads = 0;
  const reading = (async () => {
    while (!complete) {
      for (const path of files) {
        const content: unknown = JSON.parse(await readFile(path, 'utf8'));
        assert.ok(typeof content === 'object' && content !== null);
        reads += 1;
      }
    }
  })();
  try {
    for (let update = 0; update < 8; update += 1) {
      await prepareConnection(context, source, root, process.execPath);
    }
  } finally {
    complete = true;
    await reading;
  }

  assert.ok(reads > 0);
  assert.deepEqual(JSON.parse(await readFile(connectionPath, 'utf8')), source.descriptor);
  for (const path of files) assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(root)).sort(), ['connection.json', 'hooks.json', 'mcp.json']);
});

test('preparing a refreshed bridge also updates the descriptor used by an installed live plugin', async t => {
  const { root, context } = await fixture(t);
  const live = join(root, 'live', 'connection.json');
  await mkdir(join(root, 'live'));
  await writePrivateJson(live, bridge(root).descriptor);
  const source = bridge(root);
  const updated = { ...source, descriptor: { ...source.descriptor, token: 'replacement-private-token' } };
  await prepareConnection(context, updated, root, process.execPath);
  assert.deepEqual(JSON.parse(await readFile(live, 'utf8')), updated.descriptor);
  assert.equal((await stat(live)).mode & 0o777, 0o600);
});
