import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import { promisify } from 'node:util';
import type * as vscode from 'vscode';

import { anchorFromText } from '../src/anchors.js';
import type { ReviewBridge, ReviewStore } from '../src/contracts.js';
import { getHeadRevision } from '../src/git.js';
import { LocalFilesView } from '../src/localFilesView.js';
import { LocalReview, localClaudeStatus } from '../src/localReview.js';
import type { ExtensionMessage } from '../src/pullRequestOverview.js';
import { createReviewStore } from '../src/store.js';
import { wholeFileDiff } from '../src/unifiedDiff.js';
import { extensionContext, FakeMemento, resetFakeWindow, Uri, window, workspace } from './fakes/vscode.js';

const executeFile = promisify(execFile);
const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  resetFakeWindow();
  workspace.watchers.length = 0;
});

async function git(root: string, args: readonly string[]): Promise<void> {
  await executeFile('git', [
    '-C', root, '-c', 'user.name=Pair Review Test', '-c', 'user.email=pair-review@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, ...args,
  ], { encoding: 'utf8', timeout: 10_000 });
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), 'condition not reached');
}

const bridge: ReviewBridge = {
  descriptor: { version: 1, url: 'http://127.0.0.1:1', token: 'token', workspaceRoot: '/repo' },
  state: { connected: true, deliveryReady: true },
  onChange: () => ({ dispose: () => undefined }),
  dispose: () => undefined,
};

/** A repository with a changed file, an untracked file, an ignored file and an untouched one, reviewed through `LocalReview`. */
async function fixture(): Promise<{ root: string; data: string; store: ReviewStore; review: LocalReview }> {
  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'pair-review-local-')));
  cleanup.push(() => rm(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, 'repo');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await git(scratch, ['init', '--quiet', '--initial-branch=main', root]);
  await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  await writeFile(path.join(root, 'src', 'changed.ts'), 'export const changed = 1;\n');
  await writeFile(path.join(root, 'src', 'kept.ts'), 'export const kept = 1;\nexport const more = 2;\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '--quiet', '-m', 'base']);
  await writeFile(path.join(root, 'src', 'changed.ts'), 'export const changed = 2;\n');
  await writeFile(path.join(root, 'new.ts'), 'export const added = 1;\nexport const second = 2;\n');
  await writeFile(path.join(root, 'ignored.txt'), 'secret\n');
  const data = path.join(scratch, 'storage', 'local-review');
  const store = await createReviewStore(path.join(scratch, 'storage', 'review.json'), root);
  const context = { ...extensionContext(new FakeMemento()), extensionUri: Uri.file('/extension') } as unknown as vscode.ExtensionContext;
  const review = new LocalReview(context, root, store, bridge, data);
  cleanup.push(() => { review.dispose(); });
  return { root, data, store, review };
}

/** Messages the page received that carry files. */
function fileMessages(): ExtensionMessage[] {
  return (window.panels.at(-1)?.sent ?? []).filter((message): message is ExtensionMessage => typeof message === 'object' && message !== null && 'files' in message);
}

test('shows changed and untracked files, and unchanged files only while they have open threads', async () => {
  const { root, store, review } = await fixture();
  const { files } = await review.readFiles();
  assert.deepEqual(files.map((file) => [file.path, file.change]), [['new.ts', 'added'], ['src/changed.ts', 'modified']]);
  assert.deepEqual(files[0]?.hunks[0]?.lines.map((line) => [line.kind, line.newLine]), [['add', 1], ['add', 2]]);

  const base = await getHeadRevision(root);
  assert.ok(base !== undefined);
  const anchor = anchorFromText('export const kept = 1;\nexport const more = 2;\n', { path: 'src/kept.ts', startLine: 2, endLine: 2, side: 'working', baseRevision: base });
  const thread = await store.submit(anchor, 'Why two exports?', 'ask');
  const withThread = await review.readFiles();
  const kept = withThread.files.find((file) => file.path === 'src/kept.ts');
  assert.equal(kept?.change, 'unchanged');
  assert.deepEqual(kept?.hunks[0]?.lines.map((line) => [line.kind, line.oldLine, line.newLine]), [['context', 1, 1], ['context', 2, 2]]);

  await store.resolve(thread.id, true);
  assert.equal((await review.readFiles()).files.some((file) => file.path === 'src/kept.ts'), false);
});

test('comments from the page go to the workspace review at HEAD, only on files the page shows', async () => {
  const { root, store, review } = await fixture();
  await review.open();
  const panel = window.panels.at(-1);
  assert.ok(panel !== undefined);
  cleanup.push(() => { panel.dispose(); });
  assert.match(panel.webview.html, /<body class="local">/u);
  panel.receive({ action: 'ready' });
  await until(() => fileMessages().length > 0);

  panel.receive({ action: 'comment', form: 'composer', path: 'src/changed.ts', side: 'new', startLine: 1, endLine: 1, text: 'Why 2?', intent: 'implement' });
  await until(() => store.threads.length === 1);
  const [thread] = store.threads;
  assert.equal(thread?.anchor.path, 'src/changed.ts');
  assert.equal(thread?.anchor.side, 'working');
  assert.equal(thread?.anchor.baseRevision, await getHeadRevision(root));
  assert.equal(thread?.intent, 'implement');
  assert.equal(store.pendingEvents.length, 1);

  panel.receive({ action: 'comment', form: 'composer', path: 'src/kept.ts', side: 'new', startLine: 1, endLine: 1, text: 'And this?', intent: 'ask' });
  await until(() => panel.sent.some((message) => typeof message === 'object' && message !== null && 'error' in message));
  assert.equal(store.threads.length, 1);
});

test('commenting from the editor shows an unchanged file and opens a comment on its lines', async () => {
  const { review } = await fixture();
  await review.commentOn('src/kept.ts', 1, 2);
  const panel = window.panels.at(-1);
  assert.ok(panel !== undefined);
  cleanup.push(() => { panel.dispose(); });
  panel.receive({ action: 'ready' });
  await until(() => fileMessages().length > 0);
  const [message] = fileMessages();
  assert.equal(message?.files?.find((file) => file.path === 'src/kept.ts')?.change, 'unchanged');
  assert.deepEqual(message?.compose, { path: 'src/kept.ts', side: 'new', startLine: 1, endLine: 2 });

  panel.receive({ action: 'close-file', path: 'src/kept.ts' });
  await until(() => fileMessages().length > 1);
  assert.equal(fileMessages().at(-1)?.files?.some((file) => file.path === 'src/kept.ts'), false);
});

test('keeps Viewed marks in its own storage, not beside the repository', async () => {
  const { root, data, review } = await fixture();
  await review.open();
  const panel = window.panels.at(-1);
  assert.ok(panel !== undefined);
  cleanup.push(() => { panel.dispose(); });
  panel.receive({ action: 'ready' });
  await until(() => fileMessages().length > 0);
  panel.receive({ action: 'viewed', path: 'src/changed.ts', viewed: true });
  await until(() => panel.sent.some((message) => (message as ExtensionMessage).state?.viewed.includes('src/changed.ts') === true));
  await stat(path.join(data, 'reviewed-files.json'));
  await assert.rejects(stat(`${root}.review`));
});

test('says whether comments reach a Claude session and how many wait', () => {
  assert.equal(localClaudeStatus({ state: { connected: false } }, 0).text, 'Claude not connected');
  assert.equal(localClaudeStatus({ state: { connected: true, deliveryReady: true } }, 2).text, 'Claude connected · 2 waiting');
  assert.equal(localClaudeStatus({ state: { connected: true, deliveryReady: false } }, 0).text, 'Delivery paused');
});

test('lists the repository as a tree without ignored files, with open comments per file', async () => {
  const { root, store } = await fixture();
  const base = await getHeadRevision(root);
  assert.ok(base !== undefined);
  await store.submit(anchorFromText('export const kept = 1;\n', { path: 'src/kept.ts', startLine: 1, endLine: 1, side: 'working', baseRevision: base }), 'Note', 'ask');
  const view = new LocalFilesView(root, store);
  cleanup.push(() => { view.dispose(); });
  const top = await view.getChildren();
  assert.deepEqual(top.map((node) => node.kind === 'folder' ? node.folder.name : node.path), ['src', '.gitignore', 'new.ts']);
  const folder = top[0];
  assert.ok(folder !== undefined);
  const inside = await view.getChildren(folder);
  const kept = inside.find((node) => node.kind === 'file' && node.path === 'src/kept.ts');
  assert.ok(kept !== undefined);
  const item = view.getTreeItem(kept);
  assert.equal(item.description, '1 comment');
  assert.deepEqual(item.command?.arguments, ['src/kept.ts']);
});

test('shows a whole file as one hunk, and binary or empty files without lines', () => {
  assert.equal(wholeFileDiff('a.bin', Buffer.from([1, 0, 2]), 'added').binary, true);
  assert.deepEqual(wholeFileDiff('empty.ts', Buffer.from(''), 'unchanged').hunks, []);
  const added = wholeFileDiff('a.ts', Buffer.from('one\ntwo\n'), 'added');
  assert.equal(added.additions, 2);
  assert.equal(added.hunks[0]?.header, '@@ -0,0 +1,2 @@');
});
