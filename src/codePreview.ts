import { createHash } from 'node:crypto';
import * as path from 'node:path';
import highlight from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import dart from 'highlight.js/lib/languages/dart';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import objectivec from 'highlight.js/lib/languages/objectivec';
import php from 'highlight.js/lib/languages/php';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scala from 'highlight.js/lib/languages/scala';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import typescript from 'highlight.js/lib/languages/typescript';

highlight.registerLanguage('bash', bash);
highlight.registerLanguage('c', c);
highlight.registerLanguage('cpp', cpp);
highlight.registerLanguage('csharp', csharp);
highlight.registerLanguage('css', css);
highlight.registerLanguage('dart', dart);
highlight.registerLanguage('go', go);
highlight.registerLanguage('ini', ini);
highlight.registerLanguage('java', java);
highlight.registerLanguage('kotlin', kotlin);
highlight.registerLanguage('markdown', markdown);
highlight.registerLanguage('objectivec', objectivec);
highlight.registerLanguage('php', php);
highlight.registerLanguage('ruby', ruby);
highlight.registerLanguage('rust', rust);
highlight.registerLanguage('scala', scala);
highlight.registerLanguage('scss', scss);
highlight.registerLanguage('sql', sql);
highlight.registerLanguage('swift', swift);
highlight.registerLanguage('xml', xml);
highlight.registerLanguage('yaml', yaml);
highlight.registerLanguage('javascript', javascript);
highlight.registerLanguage('json', json);
highlight.registerLanguage('python', python);
highlight.registerLanguage('typescript', typescript);

const languages: Readonly<Record<string, string>> = {
  '.bash': 'bash', '.sh': 'bash', '.zsh': 'bash',
  '.cjs': 'javascript', '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript',
  '.json': 'json', '.jsonc': 'json',
  '.py': 'python', '.pyi': 'python', '.pyw': 'python',
  '.cts': 'typescript', '.mts': 'typescript', '.ts': 'typescript', '.tsx': 'typescript',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hh': 'cpp', '.hpp': 'cpp', '.cs': 'csharp',
  '.css': 'css', '.scss': 'scss', '.dart': 'dart', '.go': 'go', '.ini': 'ini', '.toml': 'ini', '.java': 'java',
  '.kt': 'kotlin', '.kts': 'kotlin', '.md': 'markdown', '.markdown': 'markdown', '.m': 'objectivec', '.mm': 'objectivec',
  '.php': 'php', '.rb': 'ruby', '.rs': 'rust', '.scala': 'scala', '.sql': 'sql', '.swift': 'swift',
  '.htm': 'xml', '.html': 'xml', '.plist': 'xml', '.svg': 'xml', '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml',
};
const tokenClasses = new Set([
  'hljs-attr', 'hljs-built_in', 'hljs-char', 'hljs-code', 'hljs-comment', 'hljs-doctag',
  'hljs-keyword', 'hljs-literal', 'hljs-meta', 'hljs-number', 'hljs-operator', 'hljs-params',
  'hljs-property', 'hljs-punctuation', 'hljs-regexp', 'hljs-string', 'hljs-subst', 'hljs-symbol',
  'hljs-title', 'hljs-type', 'hljs-variable',
  'hljs-addition', 'hljs-attribute', 'hljs-bullet', 'hljs-deletion', 'hljs-emphasis', 'hljs-link', 'hljs-name', 'hljs-quote',
  'hljs-section', 'hljs-selector-attr', 'hljs-selector-class', 'hljs-selector-id', 'hljs-selector-pseudo', 'hljs-selector-tag',
  'hljs-strong', 'hljs-tag', 'hljs-template-tag', 'hljs-template-variable',
  'class_', 'constant_', 'escape_', 'function_', 'inherited__', 'invoke__', 'language_', 'prompt_',
]);
const entities: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'" };

/** Escape source bytes before they become generated preview markup. */
export function escapeCode(code: string): string {
  return code.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#x27;');
}

/** Accept only balanced, known token spans with escaped source text matching the original. */
function safeMarkup(html: string, code: string): boolean {
  let depth = 0;
  let offset = 0;
  let source = '';
  for (const match of html.matchAll(/<[^>]*>|[^<]+/gu)) {
    if (match.index !== offset) return false;
    const part = match[0];
    offset += part.length;
    if (part === '</span>') {
      depth -= 1;
      if (depth < 0) return false;
    } else if (part.startsWith('<')) {
      const classes = /^<span class="([a-z0-9_ -]+)">$/u.exec(part)?.[1]?.split(' ');
      if (classes === undefined || classes.some((token) => !tokenClasses.has(token) && !/^tm-(?:[0-9a-f]{6}|[0-9a-f]{8}|[ibu])$/u.test(token))) return false;
      depth += 1;
    } else {
      if (part.replace(/&(?:amp|lt|gt|quot|#x27);/gu, '').includes('&')) return false;
      source += part.replace(/&(?:amp|lt|gt|quot|#x27);/gu, (entity) => entities[entity] ?? entity);
    }
  }
  return offset === html.length && depth === 0 && source === code;
}

/** Colors code the way the editor does; highlight.js covers files it cannot color yet. */
export interface EditorHighlighter {
  prepare(filePaths: readonly string[]): Promise<void>;
  highlight(code: string, filePath: string): string | undefined;
  styles(): string;
}

let editorHighlighter: EditorHighlighter | undefined;

/** Editor-colored markup by file path and content, so reading the same files again skips highlighting; bounded by total length. */
const highlighted = new Map<string, string>();
let highlightedLength = 0;
const maximumHighlightedLength = 64_000_000;

function remember(key: string, html: string): void {
  highlighted.set(key, html);
  highlightedLength += html.length;
  for (const [oldest, value] of highlighted) {
    if (highlightedLength <= maximumHighlightedLength) break;
    highlighted.delete(oldest);
    highlightedLength -= value.length;
  }
}

export function useEditorHighlighter(highlighter: EditorHighlighter | undefined): void {
  editorHighlighter = highlighter;
  highlighted.clear();
  highlightedLength = 0;
}

/** Load what `codePreviewHtml` needs to color these files like the editor. */
export async function prepareHighlighting(filePaths: readonly string[]): Promise<void> {
  await editorHighlighter?.prepare(filePaths).catch(() => undefined);
}

/** Highlight bounded, known source languages using escaped, allowlisted markup only. */
export function codePreviewHtml(code: string, filePath: string): string {
  if (code.length > 200_000) return escapeCode(code);
  const key = createHash('sha1').update(filePath).update('\0').update(code).digest('base64');
  const known = highlighted.get(key);
  if (known !== undefined) {
    highlighted.delete(key);
    highlighted.set(key, known);
    return known;
  }
  try {
    const editor = editorHighlighter?.highlight(code, filePath);
    if (editor !== undefined && safeMarkup(editor, code)) {
      remember(key, editor);
      return editor;
    }
  } catch {
    // highlight.js below still colors the file.
  }
  const language = languages[path.extname(filePath).toLowerCase()];
  if (language === undefined || code.length > 20_000) return escapeCode(code);
  try {
    const { value } = highlight.highlight(code, { language, ignoreIllegals: true });
    return safeMarkup(value, code) ? value : escapeCode(code);
  } catch {
    return escapeCode(code);
  }
}

/** Editor-like palettes follow VS Code's current light, dark and contrast webview classes. */
const fallbackStyles = `
body { --review-code-keyword: #569cd6; --review-code-string: #ce9178; --review-code-comment: #6a9955; --review-code-number: #b5cea8; --review-code-type: #4ec9b0; --review-code-function: #dcdcaa; --review-code-variable: #9cdcfe; --review-code-meta: #c586c0; }
body.vscode-light, body.vscode-high-contrast-light { --review-code-keyword: #0000ff; --review-code-string: #a31515; --review-code-comment: #008000; --review-code-number: #098658; --review-code-type: #267f99; --review-code-function: #795e26; --review-code-variable: #001080; --review-code-meta: #800000; }
body.vscode-high-contrast { --review-code-keyword: #569cd6; --review-code-string: #ce9178; --review-code-comment: #7ca668; --review-code-number: #b5cea8; --review-code-type: #4ec9b0; --review-code-function: #dcdcaa; --review-code-variable: #9cdcfe; --review-code-meta: #d78fde; }
.hljs-keyword, .hljs-literal { color: var(--review-code-keyword); }
.hljs-string, .hljs-regexp, .hljs-char { color: var(--vscode-debugTokenExpression-string, var(--review-code-string)); }
.hljs-comment, .hljs-doctag { color: var(--review-code-comment); }
.hljs-number { color: var(--vscode-debugTokenExpression-number, var(--review-code-number)); }
.hljs-type, .hljs-built_in, .hljs-title.class_ { color: var(--vscode-debugTokenExpression-type, var(--review-code-type)); }
.hljs-title.function_ { color: var(--review-code-function); }
.hljs-property, .hljs-variable, .hljs-attr { color: var(--review-code-variable); }
.hljs-meta { color: var(--review-code-meta); }
.hljs-subst, .hljs-params, .hljs-punctuation, .hljs-operator { color: var(--vscode-editor-foreground); }
.hljs-name, .hljs-selector-tag, .hljs-bullet, .hljs-template-tag { color: var(--review-code-keyword); }
.hljs-attribute, .hljs-selector-attr, .hljs-selector-class, .hljs-selector-id, .hljs-selector-pseudo, .hljs-template-variable { color: var(--review-code-variable); }
.hljs-section { color: var(--review-code-function); font-weight: 600; }
.hljs-link { color: var(--vscode-debugTokenExpression-string, var(--review-code-string)); }
.hljs-quote { color: var(--review-code-comment); }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 600; }
.hljs-addition { color: var(--vscode-gitDecoration-addedResourceForeground); }
.hljs-deletion { color: var(--vscode-gitDecoration-deletedResourceForeground); }
`;

/** Styles for highlighted code: the editor theme's colors when known, else the built-in palettes. */
export function codePreviewStyles(): string {
  return `${fallbackStyles}\n${editorHighlighter?.styles() ?? ''}`;
}
