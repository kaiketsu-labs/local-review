import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { createReviewBridge } from './bridge.js';
import { createReviewStore } from './store.js';
import { createReviewController } from './reviewController.js';
import { prepareConnection, registerClaudeLauncher } from './setup.js';
import { registerPrExport } from './prExportController.js';
import { registerReviewAppearance } from './reviewAppearance.js';
import type { ReviewBridge, ReviewStore } from './contracts.js';

let activeStore: ReviewStore | undefined;
let activeBridge: ReviewBridge | undefined;

/** Initialize one workspace-scoped review and its private local connection. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined || folder.uri.scheme !== 'file' || !vscode.workspace.isTrusted) return;
  const storage = context.storageUri;
  if (storage === undefined) return;
  try {
    await mkdir(storage.fsPath, { recursive: true, mode: 0o700 });
    const store = await createReviewStore(join(storage.fsPath, 'review.json'), folder.uri.fsPath);
    activeStore = store;
    await createReviewController(store, context);
    context.subscriptions.push(registerReviewAppearance(context));
    context.subscriptions.push(registerPrExport(context, store));
    const bridge = await createReviewBridge(store, join(storage.fsPath, 'selected-session.json'));
    activeBridge = bridge;
    context.subscriptions.push(bridge, registerClaudeLauncher(context, bridge, storage.fsPath));
    await prepareConnection(context, bridge, storage.fsPath);
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
    status.command = 'localReview.startClaude';
    const updateStatus = (): void => {
      const waiting = store.pendingEvents.length;
      const ready = bridge.state.deliveryReady === true;
      const label = !bridge.state.connected ? '$(debug-disconnect) Review · Verbinden'
        : ready ? '$(comment-discussion) Review' : '$(warning) Review · Zustellung pausiert';
      status.text = `${label}${waiting ? ` · ${waiting} wartet` : ''}`;
      status.tooltip = !bridge.state.connected
        ? 'Mit Claude Code verbinden. Abgeschickte Kommentare bleiben bis zur Bestätigung gespeichert.'
        : ready ? 'Automatische Zustellung aktiv. Claude bestätigt jeden Kommentar separat.'
          : 'Claude-Verbindung vorhanden. Die automatische Zustellung ist noch nicht aktiv. Zum Wiederverbinden klicken.';
      status.show();
    };
    context.subscriptions.push(status, store.onChange(updateStatus), bridge.onChange(updateStatus));
    updateStatus();
  } catch (error: unknown) {
    activeBridge?.dispose();
    await vscode.window.showErrorMessage(`Local Review konnte nicht starten: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Finish persisted mutations before VS Code unloads the extension. */
export async function deactivate(): Promise<void> {
  activeBridge?.dispose();
  await activeStore?.flush();
  activeBridge = undefined;
  activeStore = undefined;
}
