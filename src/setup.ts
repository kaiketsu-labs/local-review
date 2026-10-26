import { mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { ReviewBridge } from './contracts.js';
import { requireNodeRuntime, resolveExecutable } from './executables.js';
import { readPrivateJson, writePrivateJson } from './privateFiles.js';
import { quotePosix } from './shell.js';
import { installLivePlugin, showLiveConnection } from './liveSetup.js';
import { listClaudeConversations } from './claudeSessions.js';
import { readSessionBinding } from './sessionBinding.js';
export { quotePosix } from './shell.js';

const reviewTerminalName = 'Claude · Local Review';

/** Quote terminal arguments without interpreting user-configured executable paths. */
function terminalCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(quotePosix).join(' ');
}

/** Reuse this project's managed terminal when VS Code reloads the extension host. */
function existingReviewTerminal(workspaceRoot: string, inactiveTerminals: WeakSet<vscode.Terminal>): vscode.Terminal | undefined {
  return vscode.window.terminals.findLast((candidate) => {
    const options = candidate.creationOptions;
    if (options.name !== reviewTerminalName || candidate.exitStatus !== undefined || inactiveTerminals.has(candidate)) return false;
    const cwd = 'cwd' in options ? options.cwd : undefined;
    const path = typeof cwd === 'string' ? cwd : cwd?.scheme === 'file' ? cwd.fsPath : undefined;
    return path !== undefined && resolve(path) === resolve(workspaceRoot);
  });
}

/** Generate session-scoped integration files without changing Claude user settings. */
export async function prepareConnection(
  context: vscode.ExtensionContext,
  bridge: ReviewBridge,
  storagePath: string,
  runtimeNodePath?: string,
): Promise<{ readonly mcpPath: string; readonly hooksPath: string; readonly transport: 'hooks' | 'channels' }> {
  await mkdir(storagePath, { recursive: true, mode: 0o700 });
  const configuration = vscode.workspace.getConfiguration('localReview');
  const nodePath = runtimeNodePath ?? configuration.get<string>('nodePath', 'node');
  const transport = configuration.get<string>('transport', 'hooks') === 'channels' ? 'channels' : 'hooks';
  const connectionPath = join(storagePath, 'connection.json');
  const mcpPath = join(storagePath, 'mcp.json');
  const hooksPath = join(storagePath, 'hooks.json');
  const channelPath = join(context.extensionPath, 'dist', 'channel.cjs');
  const waiterPath = join(context.extensionPath, 'dist', 'hook-waiter.cjs');
  await writePrivateJson(connectionPath, bridge.descriptor);
  const liveConnection = join(storagePath, 'live', 'connection.json');
  if (await readPrivateJson(liveConnection) !== undefined) await writePrivateJson(liveConnection, bridge.descriptor);
  await writePrivateJson(mcpPath, {
    mcpServers: {
      'local-review': {
        command: nodePath,
        args: [channelPath, '--connection', connectionPath, ...(transport === 'hooks' ? ['--no-push'] : [])],
      },
    },
  });
  const waiterCommand = [nodePath, waiterPath, '--connection', connectionPath].map(quotePosix).join(' ');
  const waiter = { type: 'command', command: waiterCommand, asyncRewake: true, timeout: 86_400, statusMessage: 'Wartet auf Review-Feedback' };
  await writePrivateJson(hooksPath, {
    hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'].map(event => [event, [{ hooks: [waiter] }]])),
  });
  return { mcpPath, hooksPath, transport };
}

/** Select a conversation without guessing which recent session created the code. */
async function selectConversation(workspaceRoot: string, includeRunning = true): Promise<boolean | string | undefined> {
  const choices = [
    {
      label: 'Unterhaltung auswählen', description: 'Frühere Unterhaltung fortsetzen', resume: true as boolean | 'running',
      detail: 'Nach Name oder Branch suchen; laufende Unterhaltungen werden erkannt.',
    },
    { label: 'Neue Unterhaltung', description: 'Mit leerem Gespräch beginnen', resume: false },
  ];
  if (includeRunning) choices.push({ label: 'Laufende Unterhaltung verbinden', description: 'Im bestehenden Claude bleiben',
    detail: '/local-review:connect verbindet genau die Unterhaltung, in der du den Befehl ausführst.', resume: 'running' });
  const selection = await vscode.window.showQuickPick(choices, {
    title: 'Claude Code verbinden', placeHolder: 'Laufend verbinden, frühere Unterhaltung fortsetzen oder neu starten', matchOnDescription: true,
  });
  if (selection?.resume !== true) return selection?.resume;
  const sessions = await listClaudeConversations(workspaceRoot).catch(() => []);
  if (sessions.length === 0) return true;
  const rows = sessions.map(session => ({ label: session.title,
    description: `${session.running ? 'Läuft · ' : ''}${new Date(session.modifiedAt).toLocaleString()}${session.branch ? ` · ${session.branch}` : ''}`,
    detail: session.running ? 'Im ursprünglichen Prozess verbinden.' : `Kontext behalten · ${session.id.slice(0, 8)}`,
    value: session.running ? 'running' : session.id,
  }));
  const chosen = await vscode.window.showQuickPick([...rows, { label: 'Weitere Unterhaltungen …', description: 'Claude-Auswahl öffnen', detail: '', value: 'picker' }], {
    title: 'Unterhaltung auswählen', placeHolder: 'Nach Name oder Branch suchen', matchOnDescription: true,
  });
  return chosen?.value === 'picker' ? true : chosen?.value;
}

/** Prepare the same private review connection for either terminal location. */
async function prepareClaudeCommand(
  context: vscode.ExtensionContext, bridge: ReviewBridge, storagePath: string, resume: boolean | string,
): Promise<string> {
  const configuration = vscode.workspace.getConfiguration('localReview');
  const [executable, nodePath] = await Promise.all([
    resolveExecutable(configuration.get<string>('claudePath', 'claude'), bridge.descriptor.workspaceRoot),
    resolveExecutable(configuration.get<string>('nodePath', 'node'), bridge.descriptor.workspaceRoot),
  ]);
  await requireNodeRuntime(nodePath);
  const prepared = await prepareConnection(context, bridge, storagePath, nodePath);
  const args = ['--mcp-config', prepared.mcpPath];
  if (prepared.transport === 'hooks') args.push('--settings', prepared.hooksPath);
  else args.push('--dangerously-load-development-channels', 'server:local-review');
  if (resume) args.push('--resume');
  if (typeof resume === 'string') args.push(resume);
  const launch = terminalCommand(executable, args);
  const bindingPath = join(storagePath, 'selected-session.json');
  const binding = await readSessionBinding(bindingPath, bridge.descriptor.workspaceRoot);
  if (binding === undefined) return launch;
  const release = terminalCommand(nodePath, [join(context.extensionPath, 'dist', 'live-connect.cjs'), '--release',
    join(storagePath, 'connection.json'), bindingPath, binding.sessionId]);
  return `${release} && ${launch}`;
}

/** Connect a chosen or new conversation, or copy its command for a separate terminal. */
export function registerClaudeLauncher(
  context: vscode.ExtensionContext,
  bridge: ReviewBridge,
  storagePath: string,
): vscode.Disposable {
  const inactiveTerminals = new WeakSet<vscode.Terminal>();
  let terminal: vscode.Terminal | undefined = existingReviewTerminal(bridge.descriptor.workspaceRoot, inactiveTerminals);
  let launching = false;
  const closed = vscode.window.onDidCloseTerminal(closedTerminal => {
    inactiveTerminals.add(closedTerminal);
    if (terminal === closedTerminal) terminal = undefined;
  });
  const ended = vscode.window.onDidEndTerminalShellExecution(event => {
    inactiveTerminals.add(event.terminal);
    if (event.terminal === terminal) terminal = undefined;
  });
  const isLive = (candidate: vscode.Terminal | undefined): candidate is vscode.Terminal => candidate !== undefined
    && !inactiveTerminals.has(candidate) && candidate.exitStatus === undefined && vscode.window.terminals.includes(candidate);
  const receiverConflict = (ownedTerminal: vscode.Terminal | undefined): boolean => {
    if (bridge.state.deliveryReady !== true || isLive(ownedTerminal)) return false;
    void vscode.window.showInformationMessage('Die Review-Verbindung ist noch aktiv oder wird getrennt. Falls Claude noch läuft: /exit. Der Status aktualisiert sich innerhalb von 45 Sekunden.');
    return true;
  };
  const register = (id: string, action: () => Promise<void>): vscode.Disposable => vscode.commands.registerCommand(id, async () => {
    if (launching) return;
    launching = true;
    try {
      if (process.platform === 'win32') {
        throw new Error('Die automatische Claude-Verbindung dieser ersten Version unterstützt macOS und Linux. Windows folgt nach einer eigenen Prüfung.');
      }
      await action();
    } catch (error: unknown) {
      void vscode.window.showErrorMessage(`Local Review: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      launching = false;
    }
  });
  const connectRunning = async (): Promise<void> => {
    if (receiverConflict(undefined)) return;
    const configuration = vscode.workspace.getConfiguration('localReview');
    const [executable, nodePath] = await Promise.all([
      resolveExecutable(configuration.get<string>('claudePath', 'claude'), bridge.descriptor.workspaceRoot),
      resolveExecutable(configuration.get<string>('nodePath', 'node'), bridge.descriptor.workspaceRoot),
    ]);
    await requireNodeRuntime(nodePath);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Laufendes Claude verbinden' }, async () => {
      await installLivePlugin(context, bridge, storagePath, executable, nodePath);
    });
    if (receiverConflict(undefined)) {
      await unlink(join(storagePath, 'live', 'connect-ticket.json')).catch(() => undefined);
      return;
    }
    await unlink(join(storagePath, 'selected-session.json')).catch((error: unknown) => {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    });
    context.subscriptions.push(showLiveConnection(bridge));
  };
  const running = register('localReview.connectRunningClaude', connectRunning);
  const command = register('localReview.startClaude', async () => {
    let replaceTerminal: vscode.Terminal | undefined;
    if (!isLive(terminal)) terminal = existingReviewTerminal(bridge.descriptor.workspaceRoot, inactiveTerminals);
    const currentTerminal = terminal;
    if (receiverConflict(currentTerminal)) return;
    if (currentTerminal !== undefined) {
      const show = { label: 'Terminal anzeigen', description: 'Die bestehende Unterhaltung öffnen', restart: false };
      const restart = {
        label: bridge.state.deliveryReady === true ? 'Unterhaltung wechseln' : 'Verbindung neu starten',
        description: 'Das bisherige Review-Terminal schließen',
        detail: 'Danach wählst du eine bestehende Unterhaltung oder startest eine neue.', restart: true,
      };
      const action = await vscode.window.showQuickPick(bridge.state.deliveryReady === true ? [show, restart] : [restart, show], {
        title: bridge.state.deliveryReady === true ? 'Claude Code ist verbunden' : 'Automatische Zustellung wiederherstellen',
      });
      if (action === undefined || receiverConflict(currentTerminal)) return;
      if (!action.restart) {
        if (isLive(currentTerminal)) currentTerminal.show();
        return;
      }
      replaceTerminal = currentTerminal;
    }
    const resume = await selectConversation(bridge.descriptor.workspaceRoot);
    if (resume === undefined || receiverConflict(replaceTerminal)) return;
    if (resume === 'running') {
      await connectRunning();
      return;
    }
    const launch = await prepareClaudeCommand(context, bridge, storagePath, resume);
    if (receiverConflict(replaceTerminal)) return;
    await unlink(join(storagePath, 'selected-session.json')).catch((error: unknown) => {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    });
    if (isLive(replaceTerminal)) {
      inactiveTerminals.add(replaceTerminal);
      replaceTerminal.dispose();
    }
    terminal = vscode.window.createTerminal({ name: reviewTerminalName, cwd: bridge.descriptor.workspaceRoot });
    terminal.show();
    terminal.sendText(launch);
  });
  const copy = register('localReview.copyClaudeCommand', async () => {
    const resume = await selectConversation(bridge.descriptor.workspaceRoot, false);
    if (resume === undefined) return;
    if (resume === 'running') {
      await connectRunning();
      return;
    }
    const launch = await prepareClaudeCommand(context, bridge, storagePath, resume);
    await vscode.env.clipboard.writeText(`cd ${quotePosix(bridge.descriptor.workspaceRoot)} && ${launch}`);
    void vscode.window.showInformationMessage('Befehl kopiert. Im Shell-Prompt ausführen; laufendes Claude vorher mit /exit beenden.');
  });
  return vscode.Disposable.from(command, copy, running, closed, ended);
}
