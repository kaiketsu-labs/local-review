import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { record } from './connection.js';
import type { ReviewBridge } from './contracts.js';
import { readPrivateJson, writePrivateJson } from './privateFiles.js';
import { quotePosix } from './shell.js';
import { webviewFontStyles } from './webviewStyles.js';

/** Invoke only Claude's local plugin manager, with bounded output and no shell. */
async function pluginCommand(executable: string, args: readonly string[], cwd: string): Promise<void> {
  await new Promise<void>((done, reject) => {
    execFile(executable, ['plugin', ...args], { cwd, timeout: 45_000, maxBuffer: 128 * 1024, encoding: 'utf8' }, (error) => {
      if (error === null) done();
      else reject(new Error('Das lokale Claude-Plugin konnte nicht eingerichtet werden. Claude-Version und lokale Plugin-Richtlinien prüfen.', { cause: error }));
    });
  });
}

/** Install a workspace-local plugin that can be reloaded by the original running process. */
export async function installLivePlugin(
  context: vscode.ExtensionContext, bridge: ReviewBridge, storagePath: string,
  claudePath: string, nodePath: string,
): Promise<void> {
  const version = await new Promise<string>((done, reject) => {
    execFile(claudePath, ['--version'], { encoding: 'utf8', timeout: 5_000, maxBuffer: 4096 }, (error, stdout) => {
      if (error === null) done(stdout.trim());
      else reject(new Error('Die Claude-Version konnte nicht geprüft werden.', { cause: error }));
    });
  });
  const match = /\b(\d+)\.(\d+)\.(\d+)\s+\(Claude Code\)/u.exec(version);
  if (match === null || Number(match[1]) < 2 || (Number(match[1]) === 2 && (Number(match[2]) < 1 || (Number(match[2]) === 1 && Number(match[3]) < 280)))) {
    const found = match === null ? 'unbekannt' : `${match[1]}.${match[2]}.${match[3]}`;
    throw new Error(`Laufende Unterhaltungen benötigen Claude Code 2.1.280 oder neuer (gefunden: ${found}). „localReview.claudePath“ auf die aktuelle Installation setzen.`);
  }
  const livePath = join(storagePath, 'live');
  const marketplacePath = join(livePath, 'marketplace');
  const pluginPath = join(marketplacePath, 'plugins', 'local-review');
  const bindingPath = join(storagePath, 'selected-session.json');
  const ticketPath = join(livePath, 'connect-ticket.json');
  const connectionPath = join(livePath, 'connection.json');
  const marketplace = `local-review-${createHash('sha256').update(bridge.descriptor.workspaceRoot).digest('hex').slice(0, 12)}`;
  await Promise.all(['.claude-plugin', 'hooks', 'skills/connect'].map(directory => mkdir(join(pluginPath, directory), { recursive: true, mode: 0o700 })));
  await mkdir(join(marketplacePath, '.claude-plugin'), { recursive: true, mode: 0o700 });
  await writePrivateJson(connectionPath, bridge.descriptor);
  await writePrivateJson(join(pluginPath, '.claude-plugin', 'plugin.json'), { name: 'local-review', version: '0.4.12', description: 'Feedback aus VS Code in dieser Claude-Unterhaltung.' });
  await writePrivateJson(join(marketplacePath, '.claude-plugin', 'marketplace.json'), {
    name: marketplace, owner: { name: 'Local Review' }, plugins: [{ name: 'local-review', source: './plugins/local-review', description: 'Lokale VS-Code-Reviews.' }],
  });
  await writePrivateJson(join(pluginPath, '.mcp.json'), {
    mcpServers: { 'local-review': { command: nodePath,
      args: [join(context.extensionPath, 'dist', 'channel.cjs'), '--connection', connectionPath, '--no-push'],
      env: { LOCAL_REVIEW_SESSION_BINDING: bindingPath },
    } },
  });
  const waiter = [nodePath, join(context.extensionPath, 'dist', 'hook-waiter.cjs'), '--connection', connectionPath].map(quotePosix).join(' ');
  await writePrivateJson(join(pluginPath, 'hooks', 'hooks.json'), {
    hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'].map(event => [event, [{ hooks: [{
      type: 'command', command: `LOCAL_REVIEW_SESSION_BINDING=${quotePosix(bindingPath)} ${waiter}`,
      asyncRewake: true, timeout: 86_400, statusMessage: 'Wartet auf Review-Feedback',
    }] }]])),
  });
  const connect = [nodePath, join(context.extensionPath, 'dist', 'live-connect.cjs'), '--connection', connectionPath,
    '--binding', bindingPath, '--ticket', ticketPath, '--session', '${CLAUDE_SESSION_ID}'].map(quotePosix).join(' ');
  await writeFile(join(pluginPath, 'skills', 'connect', 'SKILL.md'), `---\nname: connect\ndescription: Diese laufende Unterhaltung mit Local Review in VS Code verbinden.\ndisable-model-invocation: true\n---\n\n!\`${connect}\`\n\nIf the connection succeeded, reply briefly that Local Review is connected. Do not edit files. Review feedback arrives separately through the Local Review hooks and tools. If the command failed, report its error; never claim success.\n`, { mode: 0o600 });
  const installedPath = join(livePath, 'installed.json');
  const installed = record(await readPrivateJson(installedPath));
  await pluginCommand(claudePath, ['marketplace', 'add', marketplacePath, '--scope', 'local'], bridge.descriptor.workspaceRoot);
  if (installed?.version === '0.4.12') {
    await pluginCommand(claudePath, ['update', `local-review@${marketplace}`, '--scope', 'local'], bridge.descriptor.workspaceRoot);
  } else {
    await pluginCommand(claudePath, ['install', `local-review@${marketplace}`, '--scope', 'local'], bridge.descriptor.workspaceRoot);
  }
  await writePrivateJson(installedPath, { version: '0.4.12' });
  await writePrivateJson(ticketPath, { version: 1, workspaceRoot: bridge.descriptor.workspaceRoot, expiresAt: Date.now() + 15 * 60_000 });
}

/** Keep first-time live connection instructions small, copyable, and tied to actual readiness. */
export function showLiveConnection(bridge: ReviewBridge): vscode.WebviewPanel {
  const nonce = randomBytes(24).toString('base64');
  const panel = vscode.window.createWebviewPanel('localReview.liveConnection', 'Claude verbinden', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
  panel.webview.html = `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">${webviewFontStyles}
body{font:13px/1.6 var(--review-font-ui);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px 18px}main{max-width:460px;margin:auto}h1{font-size:18px;margin:0 0 4px}p{color:var(--vscode-descriptionForeground);margin:0 0 18px}.command{display:flex;align-items:center;gap:12px;margin:10px 0;padding:12px;border:1px solid var(--vscode-widget-border,#80808055);border-radius:8px;background:var(--vscode-editorWidget-background)}code{flex:1;font:12px var(--review-font-code);color:var(--vscode-foreground);background:transparent;padding:0}button{cursor:pointer;font:12px var(--review-font-ui);padding:5px 9px;border:1px solid transparent;border-radius:5px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:focus-visible{outline:2px solid var(--vscode-focusBorder)}#status{margin-top:18px;font-size:12px}</style></head><body><main><h1>Laufende Unterhaltung verbinden</h1><p>Im gewünschten Claude-Terminal nacheinander ausführen.</p><div class="command"><code>/reload-plugins --force</code><button data-copy="reload">Kopieren</button></div><div class="command"><code>/local-review:connect</code><button data-copy="connect">Kopieren</button></div><p id="status" role="status" aria-live="polite">Wartet auf Verbindung …</p><p>Beim Verbinden wird der Gesprächskontext einmal neu eingelesen.</p></main><script nonce="${nonce}">const vscode=acquireVsCodeApi();document.querySelectorAll('[data-copy]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'copy',command:button.dataset.copy})));window.addEventListener('message',event=>{if(event.data.type==='state')document.getElementById('status').textContent=event.data.ready?'✓ Feedback aktiv':'Wartet auf Verbindung …';if(event.data.type==='copied')document.querySelector('[data-copy="'+event.data.command+'"]').textContent='Kopiert';});vscode.postMessage({type:'ready'});</script></body></html>`;
  const state = (): void => { void panel.webview.postMessage({ type: 'state', ready: bridge.state.deliveryReady === true }); };
  const messages = panel.webview.onDidReceiveMessage((value: unknown) => {
    const message = record(value);
    if (message?.type === 'ready') state();
    if (message?.type === 'copy' && (message.command === 'reload' || message.command === 'connect')) {
      const command = message.command;
      void vscode.env.clipboard.writeText(command === 'reload' ? '/reload-plugins --force' : '/local-review:connect')
        .then(() => panel.webview.postMessage({ type: 'copied', command }));
    }
  });
  const changed = bridge.onChange(state);
  const closed = panel.onDidDispose(() => { changed.dispose(); messages.dispose(); closed.dispose(); });
  return panel;
}
