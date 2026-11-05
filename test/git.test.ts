import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { getHeadRevision, readGitBase } from '../src/git.js';

const executeFile = promisify(execFile);

/** Run a fixture Git command directly without shell expansion. */
async function git(root: string, args: readonly string[]): Promise<void> {
  await executeFile('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10_000 });
}

test('keeps both sides of a staged rename available with the correct original contents', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pair-review-git-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await git(root, ['init', '--quiet']);
  const original = 'export const cachedValue = 42;\n';
  await writeFile(path.join(root, 'before.ts'), original);
  await git(root, ['add', '--', 'before.ts']);
  await git(root, [
    '-c', 'user.name=Pair Review Test', '-c', 'user.email=pair-review@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`,
    'commit', '--quiet', '-m', 'create fixture',
  ]);
  const revision = await getHeadRevision(root);
  assert.ok(revision !== undefined);
  await git(root, ['mv', '--', 'before.ts', 'after.ts']);

  assert.equal(await readGitBase(root, 'before.ts', revision), original);
  assert.equal(await readGitBase(root, 'after.ts', revision), '');
});

/** Commit everything staged in a fixture without user Git configuration or hooks. */
async function commit(root: string, message: string): Promise<void> {
  await git(root, [
    '-c', 'user.name=Pair Review Test', '-c', 'user.email=pair-review@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`,
    'commit', '--quiet', '-m', message,
  ]);
}

/** Create a fixture repository with one committed file. */
async function fixture(t: { after(callback: () => Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pair-review-git-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await git(root, ['init', '--quiet']);
  await writeFile(path.join(root, 'kept.ts'), 'export const kept = 1;\n');
  await writeFile(path.join(root, 'removed.ts'), 'export const removed = 1;\n');
  await git(root, ['add', '--', '.']);
  await commit(root, 'create fixture');
  return root;
}

test('reports no HEAD in a repository without commits', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pair-review-git-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await git(root, ['init', '--quiet']);

  assert.equal(await getHeadRevision(root), undefined);
});

test('reads a file at an earlier commit after it changed', async (t) => {
  const root = await fixture(t);
  const base = await getHeadRevision(root);
  assert.ok(base !== undefined);
  await writeFile(path.join(root, 'kept.ts'), 'export const kept = 2;\n');
  await git(root, ['add', '--', 'kept.ts']);
  await commit(root, 'change kept');

  assert.equal(await readGitBase(root, 'kept.ts', base), 'export const kept = 1;\n');
});
