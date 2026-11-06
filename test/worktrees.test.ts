import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { mockPullRequestProvider } from '../src/mockPullRequests.js';
import type { PullRequestProvider, PullRequestSummary } from '../src/pullRequests.js';
import { ensureWorktree, hasWorktree, migrateWorktrees, readPullRequestBase, readWorktree, removeWorktree, repositoryStorage, reviewDataPath, worktreePath } from '../src/worktrees.js';
import { cleanUpWorktrees } from '../src/worktreeCleanup.js';
import { openPullRequestFile, parsePullRequestFileUri, pullRequestFileUri, registerPullRequestDiffs } from '../src/pullRequestDiff.js';
import { commands, Uri, workspace } from './fakes/vscode.js';

const executeFile = promisify(execFile);

/** Run a fixture Git command without user configuration or hooks. */
async function git(root: string, args: readonly string[]): Promise<void> {
  await executeFile('git', [
    '-C', root, '-c', 'user.name=Pair Review Test', '-c', 'user.email=pair-review@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, ...args,
  ], { encoding: 'utf8', timeout: 10_000 });
}

const pullRequest: PullRequestSummary = {
  number: 5, title: 'Add feature', url: 'https://github.com/acme/app/pull/5',
  author: 'octo', draft: false, headBranch: 'feature', baseBranch: 'main',
};

/** Source clone whose origin has `main` plus a `feature` branch that diverged from it. */
async function fixture(t: { after(callback: () => Promise<void>): void }): Promise<{ source: string; storage: string }> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'pair-review-worktree-'));
  t.after(async () => { await rm(scratch, { recursive: true, force: true }); });
  const origin = path.join(scratch, 'origin');
  const source = path.join(scratch, 'source');
  await git(scratch, ['init', '--quiet', '--initial-branch=main', origin]);
  await writeFile(path.join(origin, 'base.ts'), 'export const base = 1;\n');
  await git(origin, ['add', '.']);
  await git(origin, ['commit', '--quiet', '-m', 'base']);
  await git(origin, ['switch', '--quiet', '-c', 'feature']);
  await writeFile(path.join(origin, 'feature.ts'), 'export const feature = 1;\n');
  await git(origin, ['add', '.']);
  await git(origin, ['commit', '--quiet', '-m', 'feature']);
  await git(origin, ['switch', '--quiet', 'main']);
  await writeFile(path.join(origin, 'later.ts'), 'export const later = 1;\n');
  await git(origin, ['add', '.']);
  await git(origin, ['commit', '--quiet', '-m', 'later on main']);
  await git(scratch, ['clone', '--quiet', origin, source]);
  return { source, storage: path.join(scratch, 'storage') };
}

const detached = async (_number: number, worktree: string): Promise<void> => { await git(worktree, ['switch', '--quiet', '--detach', 'origin/feature']); };

/** Check out the PR branch the way a code host CLI would. */
const provider = (checkouts: string[]): PullRequestProvider => ({
  ...mockPullRequestProvider,
  readRepository: async () => ({ name: 'acme/app', url: 'https://github.com/acme/app' }),
  listMine: async () => [],
  listReviewRequested: async () => [],
  listFiles: async () => [],
  viewedFiles: async () => new Set(),
  setViewed: async () => undefined,
  publishComment: async () => { throw new Error('not used'); },
  details: async () => { throw new Error('not used'); },
  threads: async () => [],
  overview: async () => { throw new Error('not used'); },
  replyToThread: async () => { throw new Error('not used'); },
  resolveThread: async () => { throw new Error('not used'); },
  deleteComment: async () => { throw new Error('not used'); },
  submitReview: async () => { throw new Error('not used'); },
  merge: async () => { throw new Error('not used'); },
  editPullRequest: async () => { throw new Error('not used'); },
  setDraft: async () => { throw new Error('not used'); },
  requestReviewers: async () => { throw new Error('not used'); },
  removeReviewers: async () => { throw new Error('not used'); },
  deleteBranch: async () => { throw new Error('not used'); },
  pickerOptions: async () => { throw new Error('not used'); },
  checkout: async (number, worktree) => {
    checkouts.push(`${number}@${worktree}`);
    await git(worktree, ['switch', '--quiet', '-c', 'feature', 'origin/feature']);
  },
});

test('creates a PR worktree once, reviews it against the merge base and removes it', async (t) => {
  const { source, storage } = await fixture(t);
  const checkouts: string[] = [];

  const folder = await ensureWorktree(source, storage, provider(checkouts), 'acme/app', pullRequest, 'reviewer');
  assert.equal(folder, worktreePath(storage, 'acme/app', 5));
  assert.equal(await ensureWorktree(source, storage, provider(checkouts), 'acme/app', pullRequest, 'reviewer'), folder);
  assert.equal(checkouts.length, 1);
  assert.equal(await hasWorktree(storage, 'acme/app', 5), true);

  const metadata = await readWorktree(storage, folder);
  assert.equal(metadata?.role, 'reviewer');
  assert.equal(metadata?.pullRequest.number, 5);
  assert.ok(await readPullRequestBase(folder, 'main') !== undefined);

  await removeWorktree(source, storage, 'acme/app', 5);
  assert.equal(await hasWorktree(storage, 'acme/app', 5), false);
  await assert.rejects(stat(folder));
});

test('keeps PR worktrees under the checkout\'s .claude/worktrees, hidden from Git without touching .gitignore', async (t) => {
  const { source } = await fixture(t);
  const storage = await repositoryStorage(source);
  assert.equal(storage, path.join(await realpath(source), '.claude', 'worktrees', 'pair-review'));

  await ensureWorktree(source, storage, { ...provider([]), checkout: detached }, 'acme/app', pullRequest, 'author');
  await ensureWorktree(source, storage, { ...provider([]), checkout: detached }, 'acme/app', { ...pullRequest, number: 6 }, 'author');
  const exclude = await readFile(path.join(source, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((line) => line === '/.claude/worktrees/pair-review/').length, 1);
  const { stdout } = await executeFile('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.equal(stdout, '');
});

test('moves worktrees out of the Git folder with their changes and comments', async (t) => {
  const { source } = await fixture(t);
  const storage = await repositoryStorage(source);
  assert.ok(storage !== undefined);
  const legacy = path.join(source, '.git', 'pair-review', 'worktrees');
  const old = await ensureWorktree(source, legacy, provider([]), 'acme/app', pullRequest, 'author');
  await writeFile(path.join(old, 'feature.ts'), 'export const feature = 2;\n');
  await mkdir(reviewDataPath(old), { recursive: true });
  await writeFile(path.join(reviewDataPath(old), 'review.json'), JSON.stringify({ version: 1, workspaceRoot: old, threads: [], events: [] }));
  await writeFile(path.join(reviewDataPath(old), 'claude-session.json'), '{}');

  assert.deepEqual(await migrateWorktrees(source, storage), []);
  const moved = worktreePath(storage, 'acme/app', 5);
  assert.equal((await readWorktree(storage, moved))?.pullRequest.number, 5);
  assert.equal(await readFile(path.join(moved, 'feature.ts'), 'utf8'), 'export const feature = 2;\n');
  assert.equal(JSON.parse(await readFile(path.join(reviewDataPath(moved), 'review.json'), 'utf8')).workspaceRoot, moved);
  await assert.rejects(stat(path.join(reviewDataPath(moved), 'claude-session.json')));
  await assert.rejects(stat(old));
  assert.deepEqual(await migrateWorktrees(source, storage), []);
});

test('cleans up worktrees of finished or unused PRs, but never one holding work', async (t) => {
  const { source } = await fixture(t);
  const storage = await repositoryStorage(source);
  assert.ok(storage !== undefined);
  const state = new Map([[5, { open: false, merged: true }], [6, { open: true, merged: false }], [7, { open: true, merged: false }], [8, { open: false, merged: false }]]);
  const host: PullRequestProvider = { ...provider([]), checkout: detached, details: async (number) => ({ ...state.get(number) }) as never };
  for (const number of state.keys()) await ensureWorktree(source, storage, host, 'acme/app', { ...pullRequest, number }, 'author');
  const longAgo = new Date(Date.now() - 30 * 86_400_000);
  await utimes(`${worktreePath(storage, 'acme/app', 7)}.json`, longAgo, longAgo);
  await writeFile(path.join(worktreePath(storage, 'acme/app', 8), 'feature.ts'), 'unsaved work\n');
  const target = { root: source, storageRoot: storage, connect: async () => host, remove: (repository: string, number: number) => removeWorktree(source, storage, repository, number) };

  assert.deepEqual(await cleanUpWorktrees(target, 14), { removed: ['#5', '#7'], kept: ['#8'] });
  assert.equal(await hasWorktree(storage, 'acme/app', 6), true);
  assert.equal(await hasWorktree(storage, 'acme/app', 8), true);
});

test('cleans up the worktree when checkout fails', async (t) => {
  const { source, storage } = await fixture(t);
  const failing: PullRequestProvider = { ...provider([]), checkout: async () => { throw new Error('checkout failed'); } };

  await assert.rejects(ensureWorktree(source, storage, failing, 'acme/app', pullRequest, 'author'), /checkout failed/u);
  await assert.rejects(stat(worktreePath(storage, 'acme/app', 5)));
  assert.equal(await hasWorktree(storage, 'acme/app', 5), false);
});

test('refuses to remove a worktree with uncommitted changes', async (t) => {
  const { source, storage } = await fixture(t);
  const folder = await ensureWorktree(source, storage, provider([]), 'acme/app', pullRequest, 'author');
  await writeFile(path.join(folder, 'feature.ts'), 'export const feature = 2;\n');

  await assert.rejects(removeWorktree(source, storage, 'acme/app', 5));
  assert.equal(await hasWorktree(storage, 'acme/app', 5), true);
});

test('ignores folders outside worktree storage and unsafe names', async (t) => {
  const { source, storage } = await fixture(t);

  assert.equal(await readWorktree(storage, source), undefined);
  await assert.rejects(ensureWorktree(source, storage, provider([]), '../escape', pullRequest, 'author'));
  await assert.rejects(ensureWorktree(source, storage, provider([]), 'acme/app', { ...pullRequest, baseBranch: '--upload-pack=x' }, 'author'));
});

test('serves both sides of a PR file from the worktree under short addresses', async (t) => {
  const { source, storage } = await fixture(t);
  const folder = await ensureWorktree(source, storage, provider([]), 'acme/app', pullRequest, 'reviewer');
  const base = await readPullRequestBase(folder, pullRequest.baseBranch);
  assert.ok(base !== undefined);
  const diffs = registerPullRequestDiffs(async () => storage);
  t.after(() => { diffs.dispose(); });
  const deleted = { originalUri: pullRequestFileUri({ repository: 'acme/app', number: 5, relativePath: 'base.ts', revision: base }) };
  const added = { modifiedUri: pullRequestFileUri({ repository: 'acme/app', number: 5, relativePath: 'feature.ts' }) };
  assert.equal(added.modifiedUri.authority, 'pr-5');
  assert.equal(added.modifiedUri.path, '/feature.ts');

  const files = workspace.fileSystems.get('pair-review-pr') as unknown as {
    readFile(uri: Uri): Promise<Uint8Array>;
    writeFile(uri: Uri, content: Uint8Array, options: object): Promise<void>;
  } | undefined;
  assert.ok(files !== undefined);
  assert.equal(Buffer.from(await files.readFile(deleted.originalUri)).toString(), 'export const base = 1;\n');
  assert.equal(Buffer.from(await files.readFile(added.modifiedUri)).toString(), 'export const feature = 1;\n');
  await files.writeFile(added.modifiedUri, Buffer.from('export const feature = 2;\n'), { create: false, overwrite: true });
  assert.equal(await readFile(path.join(folder, 'feature.ts'), 'utf8'), 'export const feature = 2;\n');
  await assert.rejects(files.writeFile(deleted.originalUri, Buffer.from('x'), { create: false, overwrite: true }), /NoPermissions/u);
});

test('opens one PR file in the native diff, or as a plain file when only one side exists', async (t) => {
  const { source, storage } = await fixture(t);
  const folder = await ensureWorktree(source, storage, provider([]), 'acme/app', pullRequest, 'reviewer');
  await writeFile(path.join(folder, 'base.ts'), 'export const base = 2;\n');
  const calls: { id: string; args: unknown[] }[] = [];
  for (const id of ['vscode.diff', 'vscode.open']) commands.handlers.set(id, (...args: unknown[]) => { calls.push({ id, args }); });
  t.after(() => { commands.handlers.delete('vscode.diff'); commands.handlers.delete('vscode.open'); });

  await openPullRequestFile(storage, 'acme/app', pullRequest, 'base.ts');
  await openPullRequestFile(storage, 'acme/app', pullRequest, 'feature.ts');

  const [diff, open] = calls;
  assert.equal(diff?.id, 'vscode.diff');
  const [original, modified, title] = diff.args as [Uri, Uri, string];
  assert.match(original.query, /rev=/u);
  assert.equal(modified.path, '/base.ts');
  assert.doesNotMatch(modified.query, /rev=/u);
  assert.equal(title, 'base.ts (#5)');
  assert.equal(open?.id, 'vscode.open');
  assert.equal((open.args[0] as Uri).path, '/feature.ts');
});

test('rejects PR file addresses that escape the worktree or use a moving revision', () => {
  const address = { repository: 'acme/app', number: 5, relativePath: 'src/a.ts', revision: 'b'.repeat(40) };
  assert.deepEqual(parsePullRequestFileUri(pullRequestFileUri(address)), address);
  assert.equal(parsePullRequestFileUri(pullRequestFileUri({ ...address, relativePath: '../secret' })), undefined);
  assert.equal(parsePullRequestFileUri(pullRequestFileUri({ ...address, revision: 'HEAD' })), undefined);
  assert.equal(parsePullRequestFileUri(pullRequestFileUri({ ...address, repository: '../../etc' })), undefined);
});
