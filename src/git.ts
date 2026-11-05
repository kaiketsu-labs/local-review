import { execFile } from 'node:child_process';
import * as path from 'node:path';

/** Run Git without a shell, allowing repositories without a first commit. */
function runGit(workspaceRoot: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', workspaceRoot, ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10_000,
    }, (error, stdout) => {
      if (error === null) {
        resolve(stdout);
      } else if (error.code === 1 || error.code === 128 || error.code === 'ENOENT') {
        resolve(undefined);
      } else {
        reject(new Error(`Die Git-Änderungen konnten nicht gelesen werden: ${error.message}`));
      }
    });
  });
}

/** A file's bytes at a fixed commit, for images and other binary files. */
export function readGitBaseBytes(workspaceRoot: string, relativePath: string, revision: string, maxBytes: number): Promise<Buffer> {
  if (!isWorkspaceRelativePath(relativePath) || !/^[a-f\d]{40,64}$/u.test(revision)) return Promise.reject(new Error('Unsupported file or revision.'));
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', workspaceRoot, 'show', `${revision}:./${relativePath}`], { encoding: 'buffer', maxBuffer: maxBytes + 1, timeout: 10_000 }, (error, stdout) => {
      if (error === null) resolve(stdout);
      else reject(new Error(`Could not read ${relativePath} at the PR's base: ${error.message}`));
    });
  });
}

/** Reject paths that escape the selected workspace. */
export function isWorkspaceRelativePath(relativePath: string): boolean {
  return relativePath.length > 0
    && !path.isAbsolute(relativePath)
    && !relativePath.includes('\0')
    && !relativePath.replaceAll('\\', '/').split('/').includes('..');
}

/** Read the immutable current commit, or return undefined for an unborn repository. */
export async function getHeadRevision(workspaceRoot: string): Promise<string | undefined> {
  const revision = (await runGit(workspaceRoot, ['rev-parse', '--verify', 'HEAD']))?.trim();
  return revision !== undefined && /^[a-f\d]{40,64}$/u.test(revision) ? revision : undefined;
}

/** Read a file from an immutable commit, using an empty base for new files. */
export async function readGitBase(
  workspaceRoot: string,
  relativePath: string,
  revision: string,
): Promise<string> {
  if (!isWorkspaceRelativePath(relativePath)) {
    throw new Error('Die Review-Datei muss in diesem Arbeitsbereich liegen.');
  }
  if (revision === 'unborn') {
    return '';
  }
  if (!/^[a-f\d]{40,64}$/u.test(revision)) {
    throw new Error('Die ursprüngliche Codeversion muss auf einen festen Git-Commit verweisen.');
  }
  return await runGit(workspaceRoot, ['show', `${revision}:./${relativePath}`]) ?? '';
}
