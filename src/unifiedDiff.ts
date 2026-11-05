import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { capturedCodeContext } from './anchors.js';
import { codePreviewHtml, escapeCode, prepareHighlighting } from './codePreview.js';
import type { CodeAnchor } from './contracts.js';
import { git } from './worktrees.js';

export interface DiffLine {
  readonly kind: 'context' | 'add' | 'del';
  readonly oldLine?: number;
  readonly newLine?: number;
  /** Escaped source, with allowlisted highlight spans. */
  readonly html: string;
}

export interface DiffHunk {
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

export interface FileDiff {
  readonly path: string;
  readonly oldPath?: string;
  /** `unchanged` is a file shown whole for review, its lines all context. */
  readonly change: 'added' | 'modified' | 'deleted' | 'renamed' | 'unchanged';
  readonly binary: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: readonly DiffHunk[];
  /** Marked `linguist-generated` or a well-known lockfile or bundle, which GitHub folds by default. */
  readonly generated?: true;
  /** Only the code saved with its comments, since the file no longer exists. */
  readonly saved?: true;
}

/** Which changes to read: `to` ends at a commit instead of the worktree, `ignoreWhitespace` leaves out whitespace-only changes. */
export interface DiffOptions { readonly to?: string; readonly ignoreWhitespace?: boolean }

interface RawLine { readonly kind: DiffLine['kind']; readonly oldLine?: number; readonly newLine?: number; readonly text: string }
interface RawFile { path: string; oldPath?: string; change: FileDiff['change']; binary: boolean; hunks: { header: string; lines: RawLine[] }[] }

/** A changed file's content before and after, so a hunk is colored with the code above it. */
export interface FileSources { readonly old?: string | undefined; readonly new?: string | undefined }

interface WholeFile { readonly lines: readonly string[]; readonly html: readonly string[] }

/** Files longer than this keep per-hunk colors, since `codePreviewHtml` leaves them plain. */
const maxWholeFileLength = 200_000;

/** A PR worktree's tracked changes against its base, highlighted per line; yields between files so a large PR does not block the extension host. */
export async function readPullRequestDiff(worktree: string, base: string, options: DiffOptions = {}): Promise<readonly FileDiff[]> {
  const output = await diffOutput(worktree, base, options);
  await prepareHighlighting([...output.matchAll(/^\+\+\+ b\/(.+)$/gmu)].map((match) => match[1] ?? ''));
  const raw = parseRawDiff(output);
  const oldPaths = raw.filter((file) => wholeFileColors(file) && file.hunks.some((hunk) => hunk.lines.some((line) => line.kind === 'del'))).map((file) => file.oldPath ?? file.path);
  const oldContents = await readBlobs(worktree, base, oldPaths).catch(() => new Map<string, string>());
  const { to } = options;
  const newContents = to === undefined ? undefined : await readBlobs(worktree, to, raw.filter(wholeFileColors).map((file) => file.path)).catch(() => new Map<string, string>());
  const generated = await generatedPaths(worktree, raw.map((file) => file.path));
  const files: FileDiff[] = [];
  for (const file of raw) {
    const current = !wholeFileColors(file) ? undefined : newContents !== undefined ? newContents.get(file.path) : await readFile(path.join(worktree, file.path), 'utf8').catch(() => undefined);
    const diff = highlightFile(file, highlightLines, { old: oldContents.get(file.oldPath ?? file.path), new: current });
    files.push(generated.has(file.path) ? { ...diff, generated: true } : diff);
    await new Promise((resolve) => { setImmediate(resolve); });
  }
  return files;
}

function diffOutput(worktree: string, base: string, { to, ignoreWhitespace }: DiffOptions = {}): Promise<string> {
  return git(worktree, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '-M', '-U3',
    ...ignoreWhitespace === true ? ['-w'] : [], base, ...to === undefined ? [] : [to], '--']);
}

/** Lockfiles and bundles GitHub's Linguist treats as generated without being told. */
const knownGenerated = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|flake\.lock|[^/]+\.min\.(?:js|css)|[^/]+\.(?:js|css)\.map)$/u;

/** Paths marked `linguist-generated` in `.gitattributes`, or well-known generated files unless marked `-linguist-generated`. */
export async function generatedPaths(worktree: string, paths: readonly string[]): Promise<ReadonlySet<string>> {
  const marked = new Map<string, string>();
  const wanted = paths.filter((file) => !file.includes('\0') && !file.includes('\n'));
  if (wanted.length > 0) {
    const output = await new Promise<string>((resolve) => {
      const child = spawn('git', ['-C', worktree, 'check-attr', '-z', '--stdin', 'linguist-generated'], { stdio: ['pipe', 'pipe', 'ignore'] });
      let text = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { text += chunk; });
      child.on('error', () => { resolve(''); });
      child.on('close', (code) => { resolve(code === 0 ? text : ''); });
      child.stdin.end(wanted.join('\0') + '\0');
    });
    const fields = output.split('\0');
    for (let index = 0; index + 2 < fields.length; index += 3) marked.set(fields[index] ?? '', fields[index + 2] ?? '');
  }
  return new Set(paths.filter((file) => {
    const value = marked.get(file);
    return value === 'set' || value === 'true' || ((value === undefined || value === 'unspecified') && knownGenerated.test(file));
  }));
}

/** Added and deleted files are one whole-file hunk already; the old version is read only to color deleted lines. */
const wholeFileColors = (file: RawFile): boolean => !file.binary && file.change !== 'added' && file.change !== 'deleted';

/** Files' content at `revision` in one Git call, since a process per file costs more than coloring it. */
function readBlobs(worktree: string, revision: string, paths: readonly string[]): Promise<Map<string, string>> {
  const wanted = paths.filter((file) => !file.includes('\n'));
  if (wanted.length === 0) return Promise.resolve(new Map());
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', worktree, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error(`git cat-file exited with ${code ?? 'a signal'}`)); return; }
      const output = Buffer.concat(chunks);
      const contents = new Map<string, string>();
      let offset = 0;
      for (const file of wanted) {
        const headerEnd = output.indexOf(0x0a, offset);
        if (headerEnd < 0) break;
        const header = output.toString('utf8', offset, headerEnd).split(' ');
        offset = headerEnd + 1;
        if (header[1] !== 'blob') continue;
        const size = Number(header[2]);
        contents.set(file, output.toString('utf8', offset, offset + size));
        offset += size + 1;
      }
      resolve(contents);
    });
    child.stdin.end(wanted.map((file) => `${revision}:./${file}\n`).join(''));
  });
}

/** The PR's changes without syntax colors, for counting and matching lines where nothing is shown. */
export async function readPlainPullRequestDiff(worktree: string, base: string): Promise<readonly FileDiff[]> {
  return parsePlainDiff(await diffOutput(worktree, base));
}

export function parsePlainDiff(output: string): readonly FileDiff[] {
  return parseRawDiff(output).map((file) => highlightFile(file, (lines) => lines.map(escapeHtml)));
}

const escapeHtml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Parse `git diff` output; lines are highlighted per side so tokens spanning lines stay correct, from the whole file when its sources are given by path. */
export function parseUnifiedDiff(output: string, sources: ReadonlyMap<string, FileSources> = new Map()): readonly FileDiff[] {
  return parseRawDiff(output).map((file) => highlightFile(file, highlightLines, sources.get(file.path)));
}

function parseRawDiff(output: string): readonly RawFile[] {
  const files: RawFile[] = [];
  let file: RawFile | undefined;
  let hunk: RawFile['hunks'][number] | undefined;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of output.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const paths = / a\/(.+) b\/(.+)$/u.exec(line);
      file = { path: paths?.[2] ?? '', change: 'modified', binary: false, hunks: [] };
      files.push(file);
      hunk = undefined;
    } else if (file === undefined) {
      continue;
    } else if (hunk !== undefined && (oldLeft > 0 || newLeft > 0) && /^[ +-]/u.test(line)) {
      const text = line.slice(1);
      if (line[0] === '+') {
        hunk.lines.push({ kind: 'add', newLine: newLine++, text });
        newLeft -= 1;
      } else if (line[0] === '-') {
        hunk.lines.push({ kind: 'del', oldLine: oldLine++, text });
        oldLeft -= 1;
      } else {
        hunk.lines.push({ kind: 'context', oldLine: oldLine++, newLine: newLine++, text });
        oldLeft -= 1;
        newLeft -= 1;
      }
    } else if (line.startsWith('@@ ')) {
      const numbers = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
      oldLine = Number(numbers?.[1] ?? 0);
      oldLeft = Number(numbers?.[2] ?? 1);
      newLine = Number(numbers?.[3] ?? 0);
      newLeft = Number(numbers?.[4] ?? 1);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
    } else if (line.startsWith('new file mode')) {
      file.change = 'added';
    } else if (line.startsWith('deleted file mode')) {
      file.change = 'deleted';
    } else if (line.startsWith('rename from ')) {
      file.change = 'renamed';
      file.oldPath = line.slice('rename from '.length);
    } else if (line.startsWith('rename to ')) {
      file.path = line.slice('rename to '.length);
    } else if (line.startsWith('+++ b/')) {
      file.path = line.slice('+++ b/'.length);
    } else if (line.startsWith('--- a/') && file.change === 'deleted') {
      file.path = line.slice('--- a/'.length);
    } else if (line.startsWith('Binary files ')) {
      file.binary = true;
    }
  }
  return files.filter((entry) => entry.path !== '');
}

function highlightFile(file: RawFile, highlight = highlightLines, sources: FileSources = {}): FileDiff {
  let additions = 0;
  let deletions = 0;
  const shown = file.hunks.flatMap((hunk) => hunk.lines);
  const lastOld = shown.reduce((last, line) => Math.max(last, line.oldLine ?? 0), 0);
  const lastNew = shown.reduce((last, line) => Math.max(last, line.newLine ?? 0), 0);
  const oldFile = highlightWholeFile(sources.old, file.oldPath ?? file.path, lastOld);
  const newFile = highlightWholeFile(sources.new, file.path, lastNew);
  const hunks = file.hunks.map(({ header, lines }) => {
    const oldSide = lines.filter((line) => line.kind !== 'add');
    const newSide = lines.filter((line) => line.kind !== 'del');
    const html = new Map<RawLine, string>();
    const oldHtml = fromWholeFile(oldSide, (line) => line.oldLine, oldFile) ?? highlight(oldSide.map((line) => line.text), file.oldPath ?? file.path);
    const newHtml = fromWholeFile(newSide, (line) => line.newLine, newFile) ?? highlight(newSide.map((line) => line.text), file.path);
    oldSide.forEach((line, index) => { html.set(line, oldHtml[index] ?? ''); });
    newSide.forEach((line, index) => { html.set(line, newHtml[index] ?? ''); });
    return {
      header,
      lines: lines.map((line): DiffLine => {
        if (line.kind === 'add') additions += 1;
        if (line.kind === 'del') deletions += 1;
        const { text: _text, ...position } = line;
        return { ...position, html: html.get(line) ?? '' };
      }),
    };
  });
  return { ...file, additions, deletions, hunks };
}

/** The file's highlighted lines up to `lastLine`, the last one a hunk shows; later code cannot change their colors. */
function highlightWholeFile(text: string | undefined, filePath: string, lastLine: number): WholeFile | undefined {
  if (text === undefined) return undefined;
  const lines = text.split('\n').slice(0, lastLine);
  const source = lines.join('\n');
  if (source.length > maxWholeFileLength) return undefined;
  const html = codePreviewHtml(source, filePath);
  if (html === escapeCode(source)) return undefined;
  return { lines, html: splitHighlightedLines(html) };
}

/** A side's lines cut from the whole file, or undefined when the file no longer matches the diff. */
function fromWholeFile(side: readonly RawLine[], lineNumber: (line: RawLine) => number | undefined, file: WholeFile | undefined): readonly string[] | undefined {
  if (file === undefined) return undefined;
  const html: string[] = [];
  for (const line of side) {
    const index = (lineNumber(line) ?? 0) - 1;
    const markup = file.html[index];
    if (file.lines[index] !== line.text || markup === undefined) return undefined;
    html.push(markup);
  }
  return html;
}

/** A whole file's lines, highlighted, for showing context the diff left out. */
export function highlightSource(text: string, filePath: string): readonly string[] {
  return highlightLines((text.endsWith('\n') ? text.slice(0, -1) : text).split('\n'), filePath);
}

/** A file outside `git diff` as one hunk: every line added for a new untracked file, or every line context for an unchanged one. */
export function wholeFileDiff(path: string, content: Buffer, change: 'added' | 'unchanged'): FileDiff {
  const empty = { path, change, additions: 0, deletions: 0, hunks: [] };
  if (content.includes(0)) return { ...empty, binary: true };
  const text = content.toString('utf8');
  if (text === '') return { ...empty, binary: false };
  const html = highlightSource(text, path);
  const kind = change === 'added' ? 'add' : 'context';
  const lines = html.map((line, index): DiffLine => ({ kind, ...change === 'added' ? {} : { oldLine: index + 1 }, newLine: index + 1, html: line }));
  const header = change === 'added' ? `@@ -0,0 +1,${lines.length} @@` : `@@ -1,${lines.length} +1,${lines.length} @@`;
  return { ...empty, binary: false, additions: change === 'added' ? lines.length : 0, hunks: [{ header, lines }] };
}

/** A file that no longer exists, shown as the code saved with each comment at its original line numbers; overlapping excerpts keep the first. */
export function savedCodeDiff(path: string, anchors: readonly CodeAnchor[]): FileDiff {
  const excerpts = anchors.map((anchor) => {
    const { text, startLine } = capturedCodeContext(anchor);
    const lines = highlightSource(text.replace(/\n$/u, ''), path);
    return { firstLine: anchor.startLine - startLine + 1, lines };
  }).sort((a, b) => a.firstLine - b.firstLine);
  const hunks: DiffHunk[] = [];
  let next = 1;
  for (const { firstLine, lines } of excerpts) {
    if (firstLine < next) continue;
    next = firstLine + lines.length;
    hunks.push({
      header: `@@ -${firstLine},${lines.length} +${firstLine},${lines.length} @@`,
      lines: lines.map((html, index): DiffLine => ({ kind: 'context', oldLine: firstLine + index, newLine: firstLine + index, html })),
    });
  }
  return { path, change: 'unchanged', saved: true, binary: false, additions: 0, deletions: 0, hunks };
}

/** Highlight consecutive lines together, then cut the markup at line breaks. */
function highlightLines(lines: readonly string[], filePath: string): readonly string[] {
  return splitHighlightedLines(codePreviewHtml(lines.join('\n'), filePath));
}

/** Split highlight markup into lines, closing and reopening spans that cross a line break. */
export function splitHighlightedLines(html: string): readonly string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = '';
  for (const match of html.matchAll(/<[^>]*>|[^<]+/gu)) {
    const part = match[0];
    if (part === '</span>') {
      open.pop();
      current += part;
    } else if (part.startsWith('<')) {
      open.push(part);
      current += part;
    } else {
      const pieces = part.split('\n');
      current += pieces[0] ?? '';
      for (const piece of pieces.slice(1)) {
        lines.push(current + '</span>'.repeat(open.length));
        current = open.join('') + piece;
      }
    }
  }
  lines.push(current);
  return lines;
}
