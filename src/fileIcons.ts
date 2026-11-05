import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser/lib/esm/main.js';
import * as vscode from 'vscode';

/** A file's icon from the user's file icon theme: a glyph of one of its fonts, or an image as a data URI. */
export type FileIcon = { readonly font: string; readonly char: string; readonly color?: string } | { readonly image: string };
/** Icons for some files, with the theme's fonts as data URIs by font id. */
export interface FileIcons { readonly fonts: Readonly<Record<string, string>>; readonly byPath: Readonly<Record<string, FileIcon>> }

interface Associations {
  readonly file?: string;
  readonly fileNames?: Readonly<Record<string, string>>;
  readonly fileExtensions?: Readonly<Record<string, string>>;
  readonly languageIds?: Readonly<Record<string, string>>;
}
interface IconDefinition { readonly iconPath?: string; readonly fontCharacter?: string; readonly fontColor?: string; readonly fontId?: string }
interface IconThemeDocument extends Associations {
  readonly iconDefinitions?: Readonly<Record<string, IconDefinition>>;
  readonly fonts?: readonly { readonly id: string; readonly src: readonly { readonly path: string; readonly format?: string }[] }[];
  readonly light?: Associations;
}
interface Theme { readonly folder: string; readonly document: IconThemeDocument }

let cached: { readonly id: string; readonly theme: Promise<Theme | undefined> } | undefined;

async function loadTheme(id: string): Promise<Theme | undefined> {
  for (const extension of vscode.extensions.all) {
    const themes = (extension.packageJSON as { contributes?: { iconThemes?: readonly { id: string; path: string }[] } }).contributes?.iconThemes ?? [];
    const entry = themes.find((theme) => theme.id === id);
    if (entry === undefined) continue;
    const file = join(extension.extensionPath, entry.path);
    return { folder: dirname(file), document: parseJsonc(await readFile(file, 'utf8')) as IconThemeDocument };
  }
  return undefined;
}

/** Language ids by file name and by extension, from every installed extension's language contributions. */
function languageIndex(): { readonly names: ReadonlyMap<string, string>; readonly extensions: ReadonlyMap<string, string> } {
  const names = new Map<string, string>();
  const extensions = new Map<string, string>();
  for (const extension of vscode.extensions.all) {
    const languages = (extension.packageJSON as { contributes?: { languages?: readonly { id: string; filenames?: readonly string[]; extensions?: readonly string[] }[] } }).contributes?.languages ?? [];
    for (const language of languages) {
      for (const name of language.filenames ?? []) names.set(name.toLowerCase(), language.id);
      for (const ext of language.extensions ?? []) extensions.set(ext.toLowerCase(), language.id);
    }
  }
  return { names, extensions };
}

/** The icon id VS Code would pick: file name, then the longest matching extension, then language, then the default. */
function iconId(path: string, sets: readonly Associations[], languages: ReturnType<typeof languageIndex>): string | undefined {
  const name = basename(path).toLowerCase();
  const suffixes = name.split('.').slice(1).map((_part, index, parts) => parts.slice(index).join('.'));
  const language = languages.names.get(name) ?? languages.extensions.get(extname(name));
  for (const pick of [
    (set: Associations) => set.fileNames?.[name] ?? Object.entries(set.fileNames ?? {}).find(([key]) => key.toLowerCase() === name)?.[1],
    (set: Associations) => suffixes.map((suffix) => set.fileExtensions?.[suffix]).find((id) => id !== undefined),
    (set: Associations) => language === undefined ? undefined : set.languageIds?.[language],
    (set: Associations) => set.file,
  ]) {
    for (const set of sets) {
      const id = pick(set);
      if (id !== undefined) return id;
    }
  }
  return undefined;
}

function dataUri(bytes: Buffer, path: string): string {
  const type = { '.svg': 'image/svg+xml', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }[extname(path).toLowerCase()] ?? 'application/octet-stream';
  return `data:${type};base64,${bytes.toString('base64')}`;
}

/** A font character as the theme writes it, such as `\E001`, as the character itself. */
function glyph(text: string): string {
  const hex = /^\\([0-9a-f]{1,6})$/iu.exec(text)?.[1];
  return hex === undefined ? text : String.fromCodePoint(Number.parseInt(hex, 16));
}

/** Icons for `paths` from the active file icon theme, or undefined when there is none or it cannot be read. */
export async function readFileIcons(paths: readonly string[]): Promise<FileIcons | undefined> {
  const id = vscode.workspace.getConfiguration('workbench').get<string | null>('iconTheme');
  if (typeof id !== 'string' || paths.length === 0) return undefined;
  if (cached?.id !== id) cached = { id, theme: loadTheme(id).catch(() => undefined) };
  const theme = await cached.theme;
  if (theme === undefined) return undefined;
  const { document, folder } = theme;
  const light = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight;
  const sets = light && document.light !== undefined ? [document.light, document] : [document];
  const languages = languageIndex();
  const fonts: Record<string, string> = {};
  const byPath: Record<string, FileIcon> = {};
  const defaultFont = document.fonts?.[0]?.id;
  for (const path of paths) {
    const definitionId = iconId(path, sets, languages);
    const definition = definitionId === undefined ? undefined : document.iconDefinitions?.[definitionId];
    if (definition?.iconPath !== undefined) {
      const file = join(folder, definition.iconPath);
      byPath[path] = { image: dataUri(await readFile(file), file) };
    } else if (definition?.fontCharacter !== undefined) {
      const fontId = definition.fontId ?? defaultFont;
      const source = document.fonts?.find((font) => font.id === fontId)?.src[0];
      if (fontId === undefined || source === undefined) continue;
      const file = join(folder, source.path);
      fonts[fontId] ??= dataUri(await readFile(file), file);
      byPath[path] = { font: fontId, char: glyph(definition.fontCharacter), ...definition.fontColor === undefined ? {} : { color: definition.fontColor } };
    }
  }
  return { fonts, byPath };
}
