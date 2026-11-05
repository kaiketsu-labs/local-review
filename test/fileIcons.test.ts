import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readFileIcons } from '../src/fileIcons.js';
import { ColorThemeKind, extensions, window, workspace } from './fakes/vscode.js';

test('picks icons by file name, then extension, then language, then the default, like VS Code', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pair-review-icons-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    extensions.all.length = 0;
    workspace.configurationValues.clear();
    window.activeColorTheme.kind = ColorThemeKind.Dark;
  });
  await writeFile(path.join(root, 'icons.woff'), 'font');
  await writeFile(path.join(root, 'md.svg'), '<svg/>');
  await writeFile(path.join(root, 'theme.json'), JSON.stringify({
    fonts: [{ id: 'glyphs', src: [{ path: './icons.woff', format: 'woff' }] }],
    iconDefinitions: { agents: { fontCharacter: '\\EA02', fontColor: '#ff657a' }, test: { fontCharacter: '\\EA10' }, py: { fontCharacter: '\\EA20' }, md: { iconPath: './md.svg' }, plain: { fontCharacter: '\\EA00' }, lightPy: { fontCharacter: '\\EA21' } },
    file: 'plain', fileNames: { 'AGENTS.md': 'agents' }, fileExtensions: { 'test.py': 'test' }, languageIds: { python: 'py', markdown: 'md' },
    light: { languageIds: { python: 'lightPy' } },
  }));
  extensions.all.push(
    { extensionPath: root, packageJSON: { contributes: { iconThemes: [{ id: 'demo', path: 'theme.json' }] } } },
    { extensionPath: root, packageJSON: { contributes: { languages: [{ id: 'python', extensions: ['.py'] }, { id: 'markdown', extensions: ['.md'] }] } } },
  );
  workspace.configurationValues.set('workbench.iconTheme', 'demo');

  const icons = await readFileIcons(['agents.md', 'docs/README.md', 'tests/a.test.py', 'src/app.py', 'Makefile']);
  assert.equal(icons?.fonts.glyphs, 'data:font/woff;base64,' + Buffer.from('font').toString('base64'));
  assert.deepEqual(icons?.byPath, {
    'agents.md': { font: 'glyphs', char: '', color: '#ff657a' },
    'docs/README.md': { image: 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64') },
    'tests/a.test.py': { font: 'glyphs', char: '' },
    'src/app.py': { font: 'glyphs', char: '' },
    Makefile: { font: 'glyphs', char: '' },
  });
  window.activeColorTheme.kind = ColorThemeKind.Light;
  assert.deepEqual((await readFileIcons(['src/app.py']))?.byPath, { 'src/app.py': { font: 'glyphs', char: '' } });
});

test('shows no icons without a file icon theme', async () => {
  workspace.configurationValues.set('workbench.iconTheme', null);
  assert.equal(await readFileIcons(['a.ts']), undefined);
  workspace.configurationValues.clear();
});
