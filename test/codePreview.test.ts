import assert from 'node:assert/strict';
import test from 'node:test';

import { codePreviewHtml, useEditorHighlighter } from '../src/codePreview.js';

/** Recover preview source after removing only generated span markup. */
function sourceText(html: string): string {
  const entities: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'" };
  return html.replace(/<\/?span(?: class="[a-z_ -]+")?>/gu, '')
    .replace(/&(?:amp|lt|gt|quot|#x27);/gu, (entity) => entities[entity] ?? entity);
}

test('Python preview highlights decorators, strings, definitions and types without changing indentation', () => {
  const code = '@field_validator("days")\n@classmethod\ndef validate_days(cls, days: int) -> int:\n    """Keep the selected range valid."""\n    return max(1, days)\n';
  const html = codePreviewHtml(code, 'src/review_lab/models.py');
  assert.match(html, /class="hljs-meta">@field_validator/u);
  assert.match(html, /class="hljs-string">&quot;days&quot;/u);
  assert.match(html, /class="hljs-keyword">def/u);
  assert.match(html, /class="hljs-title function_">validate_days/u);
  assert.match(html, /class="hljs-built_in">int/u);
  assert.equal(sourceText(html), code);
});

test('source that resembles active HTML remains escaped inside every highlighted language', () => {
  const code = 'value = "</code><img src=x onerror=alert(1)><script>bad()</script>&amp;"\r\n';
  for (const extension of ['py', 'js', 'ts', 'json', 'sh', 'swift', 'html', 'md', 'go', 'rs', 'css']) {
    const html = codePreviewHtml(code, `example.${extension}`);
    assert.doesNotMatch(html, /<(?!\/?span\b)/u);
    assert.doesNotMatch(html, /<span[^>]*(?:onerror|style|src)=/u);
    assert.equal(sourceText(html), code);
  }
});

test('Swift, HTML and Markdown get highlighted instead of falling back to plain text', () => {
  assert.match(codePreviewHtml('static func make(_ name: String) -> String {}', 'Note.swift'), /class="hljs-keyword">static/u);
  assert.match(codePreviewHtml('<div class="a">Hi</div>', 'index.html'), /class="hljs-name">div/u);
  assert.match(codePreviewHtml('# Title\n- item', 'README.md'), /class="hljs-section">/u);
});

test('known filename variants select a grammar and unsupported files remain plain source', () => {
  for (const extension of ['PY', 'pyi', 'pyw']) {
    assert.match(codePreviewHtml('return False', `example.${extension}`), /class="hljs-keyword">return/u);
  }
  for (const extension of ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx']) {
    assert.match(codePreviewHtml('const result = 2;', `example.${extension}`), /class="hljs-keyword">const/u);
  }
  const code = 'if x < 2 & y > 1\n  "Unrecognized language"';
  const html = codePreviewHtml(code, 'example.unknown');
  assert.doesNotMatch(html, /<span/u);
  assert.equal(sourceText(html), code);
});

test('large source and incomplete selections stay intact without blocking on syntax detection', () => {
  const large = 'x = "<value>"\n'.repeat(2_000);
  const html = codePreviewHtml(large, 'large.py');
  assert.doesNotMatch(html, /<span/u);
  assert.equal(sourceText(html), large);
  for (const code of ['', '@field_validator("days")', 'def validate(', '    """unfinished', '𝛑 = "🦆"\r\n']) {
    assert.equal(sourceText(codePreviewHtml(code, 'snippet.py')), code);
  }
});

test('colors the same code once until the theme changes', () => {
  let calls = 0;
  const highlighter = { prepare: async () => undefined, styles: () => '', highlight: (code: string) => { calls++; return `<span class="tm-ff0000">${code}</span>`; } };
  useEditorHighlighter(highlighter);
  try {
    assert.equal(codePreviewHtml('let', 'a.ts'), '<span class="tm-ff0000">let</span>');
    assert.equal(codePreviewHtml('let', 'a.ts'), '<span class="tm-ff0000">let</span>');
    assert.equal(calls, 1);
    codePreviewHtml('let', 'b.py');
    assert.equal(calls, 2);
    useEditorHighlighter(highlighter);
    codePreviewHtml('let', 'a.ts');
    assert.equal(calls, 3);
  } finally {
    useEditorHighlighter(undefined);
  }
});
