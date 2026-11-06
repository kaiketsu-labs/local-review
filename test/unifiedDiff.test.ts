import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseUnifiedDiff, readPullRequestDiff, savedCodeDiff, splitHighlightedLines } from '../src/unifiedDiff.js';

const output = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@ export',
  ' const a = 1;',
  '--- old comment',
  '+const b = "two";',
  ' const c = 3;',
  'diff --git a/new.md b/new.md',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/new.md',
  '@@ -0,0 +1 @@',
  '+hello',
  '\\ No newline at end of file',
  'diff --git a/old.txt b/renamed.txt',
  'similarity index 100%',
  'rename from old.txt',
  'rename to renamed.txt',
  'diff --git a/gone.bin b/gone.bin',
  'deleted file mode 100644',
  'Binary files a/gone.bin and /dev/null differ',
  '',
].join('\n');

test('parses changed, added, renamed and deleted binary files with line numbers', () => {
  const files = parseUnifiedDiff(output);
  assert.deepEqual(files.map((file) => [file.path, file.change, file.binary, file.additions, file.deletions]), [
    ['src/a.ts', 'modified', false, 1, 1],
    ['new.md', 'added', false, 1, 0],
    ['renamed.txt', 'renamed', false, 0, 0],
    ['gone.bin', 'deleted', true, 0, 0],
  ]);
  assert.equal(files[2]?.oldPath, 'old.txt');
  const lines = files[0]?.hunks[0]?.lines ?? [];
  assert.deepEqual(lines.map((line) => [line.kind, line.oldLine, line.newLine]), [
    ['context', 1, 1], ['del', 2, undefined], ['add', undefined, 2], ['context', 3, 3],
  ]);
  assert.match(lines[2]?.html ?? '', /<span class="hljs-string">&quot;two&quot;<\/span>/u);
  assert.equal(files[1]?.hunks[0]?.lines[0]?.html, 'hello');
});

test('splits highlight markup at line breaks and reopens spans that cross them', () => {
  assert.deepEqual(splitHighlightedLines('a<span class="hljs-comment">/* x\ny */</span>b\nc'),
    ['a<span class="hljs-comment">/* x</span>', '<span class="hljs-comment">y */</span>b', 'c']);
});

test('colors a hunk that starts inside a docstring from the whole file', () => {
  const source = ['def f():', '    """Doc.', '', '    More doc.', '    """', '    value = 1', ''].join('\n');
  const diff = [
    'diff --git a/f.py b/f.py',
    '--- a/f.py',
    '+++ b/f.py',
    '@@ -4,2 +4,3 @@ def f():',
    '     More doc.',
    '     """',
    '+    value = 1',
    '',
  ].join('\n');
  const valueLine = (files: ReturnType<typeof parseUnifiedDiff>): string => files[0]?.hunks[0]?.lines[2]?.html ?? '';
  assert.doesNotMatch(valueLine(parseUnifiedDiff(diff, new Map([['f.py', { old: source.replace('    value = 1\n', ''), new: source }]]))), /hljs-string/u);
});

test('reads both versions of a PR file to color hunks from the whole file', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'pair-review-diff-'));
  try {
    const run = (...args: string[]): string => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
    run('init', '-q');
    const doc = Array.from({ length: 10 }, (_, index) => `    Line ${index}.`);
    writeFileSync(join(repo, 'f.py'), ['def f():', '    """Doc.', ...doc, '    """', '    return 1', ''].join('\n'));
    run('add', '.');
    run('commit', '-qm', 'base');
    const base = run('rev-parse', 'HEAD').trim();
    writeFileSync(join(repo, 'f.py'), ['def f():', '    """Doc.', ...doc, '    """', '    value = 1', '    return value', ''].join('\n'));
    const changed = ((await readPullRequestDiff(repo, base))[0]?.hunks[0]?.lines ?? []).filter((line) => line.kind !== 'context');
    assert.deepEqual(changed.map((line) => line.kind), ['del', 'add', 'add']);
    for (const line of changed) assert.doesNotMatch(line.html, /hljs-string/u);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a deleted file shows the code saved with its comments at their original lines, keeping the first of overlapping excerpts', () => {
  const anchor = (startLine: number, contextBefore: string, selectedText: string, contextAfter: string) => ({
    path: 'gone.ts', startLine, endLine: startLine, selectedText, contextBefore, contextAfter, documentHash: 'x', side: 'working' as const, baseRevision: 'a'.repeat(40),
  });
  const file = savedCodeDiff('gone.ts', [
    anchor(20, 'const c = 3;\n', 'const d = 4;', 'const e = 5;'),
    anchor(10, 'const a = 1;\n', 'const b = 2;', ''),
    anchor(10, '', 'const b = 2;', ''),
  ]);
  assert.equal(file.change, 'unchanged');
  assert.equal(file.saved, true);
  assert.deepEqual(file.hunks.map((hunk) => hunk.lines.map((line) => [line.oldLine, line.newLine])), [[[9, 9], [10, 10]], [[19, 19], [20, 20], [21, 21]]]);
  assert.match(file.hunks[1]?.lines[1]?.html ?? '', /d/u);
});
