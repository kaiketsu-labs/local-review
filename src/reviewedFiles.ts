import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { anchorFromText, locateCodeAnchor } from './anchors.js';
import type { CodeAnchor } from './contracts.js';
import { isWorkspaceRelativePath, readGitBase } from './git.js';
import { readPrivateJson, writePrivateJson } from './privateFiles.js';
import type { PullRequestProvider } from './pullRequests.js';
import { reviewDataPath, worktreePath } from './worktrees.js';

/** Hashes by file, reused while size, inode and change times match; any write changes the change time. */
const fingerprints = new Map<string, { readonly version: string; readonly hash: string }>();
const maxFingerprints = 10_000;

/** Content hash of a worktree file, so a mark lapses once the file changes. */
async function fingerprint(worktree: string, relativePath: string): Promise<string> {
  const file = join(worktree, relativePath);
  const info = await stat(file, { bigint: true }).catch(() => undefined);
  if (info === undefined) return 'deleted';
  const version = `${info.size}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`;
  const known = fingerprints.get(file);
  if (known?.version === version) return known.hash;
  const content = await readFile(file).catch(() => undefined);
  const hash = content === undefined ? 'deleted' : createHash('sha256').update(content).digest('hex').slice(0, 16);
  if (fingerprints.size >= maxFingerprints) fingerprints.clear();
  fingerprints.set(file, { version, hash });
  return hash;
}

function marksPath(data: string): string {
  return join(data, 'reviewed-files.json');
}

/** Lines marked read, kept as an anchor so the mark follows its code and lapses once that code changes. */
interface StoredRange {
  readonly id: string;
  readonly anchor: CodeAnchor;
}

interface Marks {
  readonly files: Record<string, string>;
  readonly ranges: StoredRange[];
}

const anchorText = ['path', 'selectedText', 'contextBefore', 'contextAfter', 'documentHash', 'baseRevision'] as const;

function isStoredRange(value: unknown): value is StoredRange {
  if (typeof value !== 'object' || value === null) return false;
  const { id, anchor } = value as Record<string, unknown>;
  if (typeof id !== 'string' || typeof anchor !== 'object' || anchor === null) return false;
  const fields = anchor as Record<string, unknown>;
  return anchorText.every((key) => typeof fields[key] === 'string') && isWorkspaceRelativePath(fields.path as string)
    && (fields.side === 'working' || fields.side === 'original')
    && Number.isSafeInteger(fields.startLine) && Number.isSafeInteger(fields.endLine);
}

/** Each read mark keeps its code and context, so a guided review of a large PR outgrows the default metadata limit. */
const maximumMarksBytes = 16 * 1024 * 1024;

/** Rejects when the marks file is unreadable, so a write never replaces marks it could not read. */
async function readMarks(data: string): Promise<Marks> {
  const value = await readPrivateJson(marksPath(data), maximumMarksBytes);
  const { files, ranges } = typeof value === 'object' && value !== null ? value as { files?: unknown; ranges?: unknown } : {};
  return {
    files: typeof files === 'object' && files !== null
      ? Object.fromEntries(Object.entries(files).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : {},
    ranges: Array.isArray(ranges) ? ranges.filter(isStoredRange) : [],
  };
}

function noMarks(): Marks {
  return { files: {}, ranges: [] };
}

async function writeMarks(data: string, marks: Marks): Promise<void> {
  await mkdir(data, { recursive: true, mode: 0o700 });
  await writePrivateJson(marksPath(data), marks);
}

const updates = new Map<string, Promise<void>>();

/** Change the marks in `data` one update at a time, so concurrent ticks don't overwrite each other. */
function updateMarks(data: string, change: (marks: Marks) => Marks | Promise<Marks>): Promise<void> {
  const key = marksPath(data);
  const run = (updates.get(key) ?? Promise.resolve()).then(async () => { await writeMarks(data, await change(await readMarks(data))); });
  updates.set(key, run.catch(() => undefined));
  return run;
}

/** Paths among `paths` marked reviewed whose content is unchanged since. Marks live in `data`, beside the worktree unless given. */
export async function readReviewedFiles(worktree: string, paths: readonly string[], data = reviewDataPath(worktree)): Promise<ReadonlySet<string>> {
  const { files } = await readMarks(data).catch(() => noMarks());
  const current = await Promise.all(paths.map(async (path) => files[path] !== undefined && files[path] === await fingerprint(worktree, path)));
  return new Set(paths.filter((_path, index) => current[index]));
}

/** Mark a file reviewed at its current content, or clear the mark. */
export async function setFileReviewed(worktree: string, relativePath: string, reviewed: boolean, data = reviewDataPath(worktree)): Promise<void> {
  if (!isWorkspaceRelativePath(relativePath)) throw new Error(`Unsupported file path: ${relativePath}`);
  await updateMarks(data, async (marks) => {
    if (reviewed) marks.files[relativePath] = await fingerprint(worktree, relativePath);
    else delete marks.files[relativePath];
    return marks;
  });
}

/** Lines of one diff side: the base ("old") or the PR's version ("new"). */
export interface LineRange {
  readonly path: string;
  readonly side: 'old' | 'new';
  readonly startLine: number;
  readonly endLine: number;
}

/** A range marked read, at its current lines. */
export interface ReadRange extends LineRange {
  readonly id: string;
}

async function sideText(worktree: string, base: string, path: string, side: LineRange['side']): Promise<string | undefined> {
  return side === 'old' ? readGitBase(worktree, path, base).catch(() => undefined) : readFile(join(worktree, path), 'utf8').catch(() => undefined);
}

/** Ranges marked read whose code is still there, at its current lines against `base`. */
export async function readReadRanges(worktree: string, base: string, data = reviewDataPath(worktree)): Promise<readonly ReadRange[]> {
  const { ranges } = await readMarks(data).catch(() => noMarks());
  const texts = new Map<string, Promise<string | undefined>>();
  const found = await Promise.all(ranges.map(async ({ id, anchor }): Promise<ReadRange | undefined> => {
    const side = anchor.side === 'original' ? 'old' : 'new';
    const key = `${side}:${anchor.path}`;
    if (!texts.has(key)) texts.set(key, sideText(worktree, base, anchor.path, side));
    const text = await texts.get(key);
    const location = text === undefined ? undefined : locateCodeAnchor(text, anchor);
    return location === undefined ? undefined : { id, path: anchor.path, side, ...location };
  }));
  return found.filter((range) => range !== undefined);
}

/** Mark lines read at their current content. */
export async function markRangeRead(worktree: string, base: string, range: LineRange, data = reviewDataPath(worktree)): Promise<void> {
  if (!isWorkspaceRelativePath(range.path)) throw new Error(`Unsupported file path: ${range.path}`);
  const text = await sideText(worktree, base, range.path, range.side);
  if (text === undefined) throw new Error(`Could not read ${range.path}.`);
  const anchor = anchorFromText(text, { ...range, side: range.side === 'old' ? 'original' : 'working', baseRevision: base });
  await updateMarks(data, (marks) => ({ ...marks, ranges: [...marks.ranges, { id: randomUUID(), anchor }] }));
}

/** Clear read marks by id. */
export async function unmarkRangesRead(worktree: string, ids: readonly string[], data = reviewDataPath(worktree)): Promise<void> {
  await updateMarks(data, (marks) => ({ ...marks, ranges: marks.ranges.filter((range) => !ids.includes(range.id)) }));
}

/** Reviewed files per PR: local ticks merged with the code host's "Viewed" flags, which are cached until `forget`. */
export class FileReviews implements vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<string>();
  /** Fires with `owner/name#number` of the PR whose files were ticked or unticked. */
  readonly onDidChange = this.#changed.event;
  readonly #viewed = new Map<string, Promise<Set<string>>>();

  constructor(private readonly storageRoot: string) {}

  /** Files among `paths` that are reviewed locally or marked Viewed on the code host. */
  async reviewed(provider: PullRequestProvider, repository: string, number: number, paths: readonly string[]): Promise<ReadonlySet<string>> {
    const [local, viewed] = await Promise.all([
      readReviewedFiles(worktreePath(this.storageRoot, repository, number), paths),
      this.#viewedOn(provider, repository, number).catch(() => new Set<string>()),
    ]);
    return new Set(paths.filter((path) => local.has(path) || viewed.has(path)));
  }

  /** Tick or untick a file here and on the code host. */
  async set(provider: PullRequestProvider, repository: string, number: number, path: string, reviewed: boolean): Promise<void> {
    await setFileReviewed(worktreePath(this.storageRoot, repository, number), path, reviewed);
    const viewed = await this.#viewedOn(provider, repository, number).catch(() => undefined);
    if (reviewed) viewed?.add(path);
    else viewed?.delete(path);
    this.#changed.fire(`${repository}#${number}`);
    await provider.setViewed(number, path, reviewed);
  }

  /** Line ranges of a PR marked read and still unchanged. */
  readRanges(repository: string, number: number, base: string): Promise<readonly ReadRange[]> {
    return readReadRanges(worktreePath(this.storageRoot, repository, number), base);
  }

  async markRead(repository: string, number: number, base: string, range: LineRange): Promise<void> {
    await markRangeRead(worktreePath(this.storageRoot, repository, number), base, range);
    this.#changed.fire(`${repository}#${number}`);
  }

  async unmarkRead(repository: string, number: number, ids: readonly string[]): Promise<void> {
    await unmarkRangesRead(worktreePath(this.storageRoot, repository, number), ids);
    this.#changed.fire(`${repository}#${number}`);
  }

  /** Read the code host's Viewed flags again next time. */
  forget(): void {
    this.#viewed.clear();
  }

  dispose(): void {
    this.#changed.dispose();
  }

  #viewedOn(provider: PullRequestProvider, repository: string, number: number): Promise<Set<string>> {
    const key = `${repository}#${number}`;
    let viewed = this.#viewed.get(key);
    if (viewed === undefined) {
      viewed = provider.viewedFiles(number).then((files) => new Set(files));
      viewed.catch(() => { this.#viewed.delete(key); });
      this.#viewed.set(key, viewed);
    }
    return viewed;
  }
}
