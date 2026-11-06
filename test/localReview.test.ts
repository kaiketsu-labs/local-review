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
import { checkoutLabel, groupByRepository, listLocalCheckouts, matchesFilter, parseWorktreeList, type LocalCheckout } from '../src/localCheckouts.js';
import { LocalReview, localClaudeStatus } from '../src/localReview.js';
import { LocalSessions } from '../src/localSessions.js';
import { type ExtensionMessage, isPageOpen, type OverviewActions, showPullRequestOverview } from '../src/pullRequestOverview.js';
import type { ClaudeChoice, ClaudeLauncher } from '../src/setup.js';
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

/** A launcher that records the page's Claude choices instead of starting Claude. */
function fakeLauncher(): ClaudeLauncher & { readonly choices: ClaudeChoice[] } {
  const choices: ClaudeChoice[] = [];
  return {
    choices, hasTerminal: false,
    start: async () => undefined, copyCommand: async () => undefined, connectRunning: async () => undefined,
    onDidChange: () => ({ dispose: () => undefined }),
    conversations: async () => [{ id: '0f5c3c5e-1111-4222-8333-944445555666', title: 'Retry backoff', modifiedAt: 0, branch: 'main', running: true }],
    connect: async (choice) => { choices.push(choice); return choice.how === 'copy' ? 'Command copied.' : undefined; },
    dispose: () => undefined,
  };
}

/** A repository with a changed file, an untracked file, an ignored file and an untouched one, reviewed through `LocalReview`. */
async function fixture(): Promise<{ root: string; data: string; store: ReviewStore; review: LocalReview; launcher: ReturnType<typeof fakeLauncher> }> {
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
  const launcher = fakeLauncher();
  const review = new LocalReview(context, root, store, bridge, data, launcher);
  cleanup.push(() => { review.dispose(); });
  return { root, data, store, review, launcher };
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

test('opening an unchanged file shows it whole until it is closed', async () => {
  const { review } = await fixture();
  await review.openFile('src/kept.ts');
  const panel = window.panels.at(-1);
  assert.ok(panel !== undefined);
  cleanup.push(() => { panel.dispose(); });
  panel.receive({ action: 'ready' });
  await until(() => fileMessages().length > 0);
  const [message] = fileMessages();
  assert.equal(message?.files?.find((file) => file.path === 'src/kept.ts')?.change, 'unchanged');

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
  const checkout: LocalCheckout = { root, name: 'repo', repository: root, branch: 'main', kind: 'folder' };
  const view = new LocalFilesView(async () => [checkout], async () => store.threads);
  cleanup.push(() => { view.dispose(); });
  const top = await view.getChildren();
  assert.deepEqual(top.map((node) => node.kind === 'folder' ? node.folder.name : node.kind === 'file' ? node.path : node.kind), ['src', '.gitignore', 'new.ts']);
  const folder = top[0];
  assert.ok(folder !== undefined);
  const inside = await view.getChildren(folder);
  const kept = inside.find((node) => node.kind === 'file' && node.path === 'src/kept.ts');
  assert.ok(kept !== undefined);
  const item = await view.getTreeItem(kept);
  assert.equal(item.description, '1 comment');
  assert.deepEqual(item.command?.arguments, [root, 'src/kept.ts']);
});

test('lists a repository and its worktrees as checkouts, each with its own files', async () => {
  const { root } = await fixture();
  await git(root, ['add', '.']);
  await git(root, ['commit', '--quiet', '-m', 'more']);
  const worktree = path.join(path.dirname(root), 'repo-fix');
  await git(root, ['worktree', 'add', '--quiet', '-b', 'fix/anchors', worktree]);
  const checkouts = await listLocalCheckouts([root]);
  assert.deepEqual(checkouts.map(({ root: folder, branch, kind, repository }) => [folder, branch, kind, repository]), [[root, 'main', 'folder', root], [worktree, 'fix/anchors', 'worktree', root]]);
  assert.equal(checkoutLabel(checkouts[1]!), 'fix/anchors');

  const view = new LocalFilesView(async () => checkouts, async () => []);
  cleanup.push(() => { view.dispose(); });
  const [group] = await view.getChildren();
  assert.ok(group?.kind === 'repository');
  assert.equal((await view.getTreeItem(group)).description, '2');
  const rows = await view.getChildren(group);
  assert.deepEqual(rows.map((node) => node.kind === 'checkout' ? node.checkout.branch : node.kind), ['main', 'fix/anchors']);
  const files = await view.getChildren(rows[1]);
  const added = files.find((node) => node.kind === 'file' && node.path === 'new.ts');
  assert.ok(added !== undefined);
  assert.deepEqual((await view.getTreeItem(added)).command?.arguments, [worktree, 'new.ts']);
});

test('reads Git\'s worktree list without bare or prunable entries', () => {
  assert.deepEqual(parseWorktreeList('worktree /a\nHEAD 1234567890\nbranch refs/heads/main\n\nworktree /b\nHEAD abcdef1234\ndetached\n\nworktree /c\nHEAD 1\nprunable gitdir file points to non-existent location\n\nworktree /d\nbare\n'),
    [{ path: '/a', branch: 'main' }, { path: '/b', branch: 'abcdef1' }]);
});

test('shows a whole file as one hunk, and binary or empty files without lines', () => {
  assert.equal(wholeFileDiff('a.bin', Buffer.from([1, 0, 2]), 'added').binary, true);
  assert.deepEqual(wholeFileDiff('empty.ts', Buffer.from(''), 'unchanged').hunks, []);
  const added = wholeFileDiff('a.ts', Buffer.from('one\ntwo\n'), 'added');
  assert.equal(added.additions, 2);
  assert.equal(added.hunks[0]?.header, '@@ -0,0 +1,2 @@');
});

test('connects Claude from the page menu and lists conversations to resume', async () => {
  const { review, launcher } = await fixture();
  await review.open();
  const panel = window.panels.at(-1);
  assert.ok(panel !== undefined);
  cleanup.push(() => { panel.dispose(); });
  const sent = (key: string): unknown[] => panel.sent.filter((message) => typeof message === 'object' && message !== null && key in message);

  panel.receive({ action: 'claude-conversations' });
  await until(() => sent('conversations').length > 0);
  assert.deepEqual((sent('conversations')[0] as ExtensionMessage).conversations?.map((conversation) => conversation.title), ['Retry backoff']);

  panel.receive({ action: 'connect-claude', how: 'resume', session: '0f5c3c5e-1111-4222-8333-944445555666' });
  panel.receive({ action: 'connect-claude', how: 'resume', session: '--dangerously-skip-permissions' });
  panel.receive({ action: 'connect-claude', how: 'copy' });
  panel.receive({ action: 'connect-claude', how: 'running' });
  await until(() => sent('runningReady').length > 0);
  assert.deepEqual(launcher.choices, [{ how: 'resume', session: '0f5c3c5e-1111-4222-8333-944445555666' }, { how: 'copy' }, { how: 'running' }]);
  assert.deepEqual((sent('notice')[0] as ExtensionMessage).notice, { text: 'Command copied.' });
});

test('gives each checkout its own comments, Claude connection and page', async () => {
  const { root } = await fixture();
  await git(root, ['add', '.']);
  await git(root, ['commit', '--quiet', '-m', 'more']);
  const worktree = path.join(path.dirname(root), 'repo-fix');
  await git(root, ['worktree', 'add', '--quiet', '-b', 'fix/anchors', worktree]);
  const storage = path.join(path.dirname(root), 'window-storage');
  const context = { ...extensionContext(new FakeMemento()), extensionUri: Uri.file('/extension'), extensionPath: '/extension' } as unknown as vscode.ExtensionContext;
  const sessions = new LocalSessions(context, storage, undefined);
  cleanup.push(() => { sessions.dispose(); });
  const [first, second] = await Promise.all([sessions.get(root), sessions.get(worktree)]);
  assert.equal(await sessions.get(root), first);
  assert.notEqual(first.store, second.store);
  assert.equal(first.bridge.descriptor.workspaceRoot, root);
  assert.equal(second.bridge.descriptor.workspaceRoot, worktree);
  assert.notEqual(first.bridge.descriptor.url, second.bridge.descriptor.url);

  const before = window.panels.length;
  await first.review.open();
  await second.review.open();
  await first.review.open();
  assert.equal(window.panels.length, before + 2);
  for (const panel of window.panels.slice(-2)) cleanup.push(() => { panel.dispose(); });

  const restored = new LocalSessions(context, storage, undefined);
  cleanup.push(() => { restored.dispose(); });
  await restored.restore(async () => true);
  assert.equal((await restored.find(worktree))?.store.workspaceRoot, worktree);
});

test('offers the branch\'s open PR and hands the tab to its review page', async () => {
  const { review } = await fixture();
  const opened: number[] = [];
  const pullRequest = { number: 31, title: 'Retry backoff', url: 'https://github.com/o/r/pull/31', author: 'me', draft: false, headBranch: 'main', baseBranch: 'develop' };
  review.usePullRequests({ find: async (branch) => branch === 'main' ? pullRequest : undefined, open: async (found) => { opened.push(found.number); } });
  await review.open();
  const panel = window.panels.at(-1);
  assert.ok(panel !== undefined);
  cleanup.push(() => { panel.dispose(); });
  await until(() => panel.sent.some((message) => (message as ExtensionMessage).state?.branchPullRequest?.number === 31));

  panel.receive({ action: 'open-pr' });
  await until(() => opened.length === 1);
  assert.deepEqual(opened, [31]);

  const before = window.panels.length;
  await showPullRequestOverview('o/r#31', async () => ({ title: '#31 Retry backoff', author: 'me', headBranch: 'main', baseBranch: 'develop', url: pullRequest.url,
    viewed: [], read: [], claude: { text: '', running: false, retry: false }, analysis: { running: false, stale: false }, threads: [] }),
  () => ({ dispose: () => undefined }), { readFiles: async () => ({ files: [], selection: { range: { kind: 'all' }, whitespace: false }, atHead: true }), pollGitHub: async () => ({ reload: false, files: false }) } as unknown as OverviewActions,
  Uri.file('/extension') as unknown as vscode.Uri, undefined, undefined, review.key);
  assert.equal(window.panels.length, before);
  assert.equal(panel.disposed, false);
  assert.doesNotMatch(panel.webview.html, /<body class="local">/u);
  assert.equal(isPageOpen(review.key), false);
  assert.equal(isPageOpen('o/r#31'), true);
});

test('groups checkouts by repository and filters them by repository, branch or PR', () => {
  const pr = (number: number, title: string) => ({ version: 1 as const, repository: 'o/a', role: 'author' as const,
    pullRequest: { number, title, url: '', author: 'me', draft: false, headBranch: 'x', baseBranch: 'main' } });
  const checkouts: LocalCheckout[] = [
    { root: '/b', name: 'beta', repository: '/b', branch: 'main', kind: 'folder' },
    { root: '/a/pr-26', name: 'alpha', repository: '/a', branch: 'abc1234', kind: 'pr', pullRequest: pr(26, 'Review page') },
    { root: '/a-fix', name: 'alpha', repository: '/a', branch: 'fix/anchors', kind: 'worktree' },
    { root: '/a', name: 'alpha', repository: '/a', branch: 'main', kind: 'folder' },
    { root: '/a/pr-19', name: 'alpha', repository: '/a', branch: 'def5678', kind: 'pr', pullRequest: pr(19, 'Sandbox') },
  ];
  assert.deepEqual(groupByRepository(checkouts).map(({ name, checkouts: members }) => [name, members.map(checkoutLabel)]),
    [['alpha', ['main', 'fix/anchors', '#19 Sandbox', '#26 Review page']], ['beta', ['main']]]);
  assert.deepEqual(checkouts.filter((checkout) => matchesFilter(checkout, 'ANCH')).map((checkout) => checkout.root), ['/a-fix']);
  assert.deepEqual(checkouts.filter((checkout) => matchesFilter(checkout, '#19')).map((checkout) => checkout.root), ['/a/pr-19']);
  assert.equal(checkouts.filter((checkout) => matchesFilter(checkout, 'beta')).length, 1);
});
