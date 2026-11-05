import { realpath } from 'node:fs/promises';
import { basename, sep } from 'node:path';
import { git, readWorktree, repositoryStorage, type PullRequestWorktree } from './worktrees.js';

/** A folder holding one branch of a repository: a workspace folder, a repository nested in one, or one of their Git worktrees. */
export interface LocalCheckout {
  readonly root: string;
  /** The repository's name, from its main checkout's folder. */
  readonly name: string;
  /** The repository's main checkout, shared by all its worktrees. */
  readonly repository: string;
  /** The checked-out branch, or the short commit when HEAD is detached. */
  readonly branch: string;
  /** `folder` is opened in VS Code, `worktree` is another Git worktree, `pr` is a worktree Pair Review made for a pull request. */
  readonly kind: 'folder' | 'worktree' | 'pr';
  /** The PR a `pr` checkout holds. */
  readonly pullRequest?: PullRequestWorktree;
}

interface ListedWorktree { readonly path: string; readonly branch: string }

/** Worktrees `git worktree list --porcelain` reports, without bare, missing or prunable ones. */
export function parseWorktreeList(output: string): readonly ListedWorktree[] {
  return output.split('\n\n').flatMap((block) => {
    const lines = block.split('\n');
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    if (path === undefined || lines.some((line) => line === 'bare' || line.startsWith('prunable'))) return [];
    const branch = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length).replace(/^refs\/heads\//u, '');
    const head = lines.find((line) => line.startsWith('HEAD '))?.slice('HEAD '.length, 'HEAD '.length + 7);
    return [{ path, branch: branch ?? head ?? 'detached' }];
  });
}

const canonical = (path: string): Promise<string> => realpath(path).catch(() => path);

/**
 * Every checkout of the given repositories, each listed once: the repositories themselves first, in order, then their other worktrees by path.
 * Worktrees inside a `.git` folder are left out; Claude cannot edit there.
 */
export async function listLocalCheckouts(repositories: readonly string[]): Promise<readonly LocalCheckout[]> {
  const opened = new Set(await Promise.all(repositories.map(canonical)));
  const listed = new Map<string, LocalCheckout>();
  const others: LocalCheckout[] = [];
  for (const repository of repositories) {
    const output = await git(repository, ['worktree', 'list', '--porcelain']).catch(() => undefined);
    if (output === undefined) continue;
    const worktrees = parseWorktreeList(output);
    const main = await canonical(worktrees[0]?.path ?? repository);
    const name = basename(main);
    const storage = await repositoryStorage(repository);
    for (const { path, branch } of worktrees) {
      const root = await canonical(path);
      if (listed.has(root) || root.split(sep).includes('.git')) continue;
      const pullRequest = storage === undefined ? undefined : await readWorktree(storage, root);
      const checkout: LocalCheckout = { root, name, repository: main, branch, kind: opened.has(root) ? 'folder' : pullRequest === undefined ? 'worktree' : 'pr',
        ...pullRequest === undefined || opened.has(root) ? {} : { pullRequest } };
      listed.set(root, checkout);
      if (checkout.kind !== 'folder') others.push(checkout);
    }
  }
  const folders = (await Promise.all(repositories.map(canonical))).flatMap((root) => {
    const checkout = listed.get(root);
    return checkout === undefined ? [] : [checkout];
  });
  return [...new Map(folders.map((checkout) => [checkout.root, checkout])).values(), ...others.sort((a, b) => a.root.localeCompare(b.root))];
}

/** How a checkout's row under its repository names it: the branch, or the PR's number and title. */
export function checkoutLabel(checkout: LocalCheckout): string {
  const pr = checkout.pullRequest?.pullRequest;
  return pr === undefined ? checkout.branch : `#${pr.number} ${pr.title}`;
}

/** Whether a checkout's repository, branch, or PR number or title contains `filter`, ignoring case. */
export function matchesFilter(checkout: LocalCheckout, filter: string): boolean {
  const query = filter.trim().toLowerCase();
  const pr = checkout.pullRequest?.pullRequest;
  return query === '' || [checkout.name, checkout.branch, ...pr === undefined ? [] : [`#${pr.number}`, pr.title]].some((text) => text.toLowerCase().includes(query));
}

const kindOrder: Record<LocalCheckout['kind'], number> = { folder: 0, worktree: 1, pr: 2 };

/** Checkouts grouped by repository, repositories by name; inside one, opened folders first, then worktrees by branch, then PRs by number. */
export function groupByRepository(checkouts: readonly LocalCheckout[]): readonly { readonly repository: string; readonly name: string; readonly checkouts: readonly LocalCheckout[] }[] {
  const groups = new Map<string, LocalCheckout[]>();
  for (const checkout of checkouts) groups.set(checkout.repository, [...groups.get(checkout.repository) ?? [], checkout]);
  return [...groups].map(([repository, members]) => ({
    repository, name: members[0]?.name ?? repository,
    checkouts: [...members].sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind]
      || (a.pullRequest?.pullRequest.number ?? 0) - (b.pullRequest?.pullRequest.number ?? 0) || a.branch.localeCompare(b.branch)),
  })).sort((a, b) => a.name.localeCompare(b.name) || a.repository.localeCompare(b.repository));
}

