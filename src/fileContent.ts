import { lstat, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readGitBaseBytes } from './git.js';
import { htmlPreview } from './htmlPreview.js';
import { inlineLocalImages, markdownBlocks } from './markdown.js';
import { maxMediaBytes, mediaType, type MediaPreview, type MediaSide } from './media.js';
import type { FilePreview } from './pullRequestOverview.js';
import type { FileDiff } from './unifiedDiff.js';
import { git } from './worktrees.js';

/** A Markdown file in `folder` as rendered blocks with its local images inlined, or an HTML file's source for a sandboxed frame. */
export async function readFilePreview(folder: string, path: string): Promise<FilePreview> {
  const text = await readFile(join(folder, path), 'utf8');
  if (/\.html?$/iu.test(path)) return { kind: 'html', ...htmlPreview(text) };
  const readImage = async (image: string): Promise<Buffer | undefined> => {
    const file = join(folder, image);
    const info = await lstat(file).catch(() => undefined);
    return info?.isFile() === true && info.size <= maxMediaBytes ? await readFile(file) : undefined;
  };
  const blocks = await Promise.all(markdownBlocks(text).map(async (block) => ({ ...block, html: await inlineLocalImages(block.html, path, readImage) })));
  return { kind: 'markdown', blocks };
}

/** A changed image, SVG or PDF at `base` and in `folder`, each side left out when the change added or deleted it. */
export async function readMediaSides(folder: string, file: FileDiff, base: string): Promise<MediaPreview> {
  const mime = mediaType(file.path);
  if (mime === undefined) throw new Error(`${file.path} is not an image or PDF.`);
  const side = async (read: () => Promise<Buffer>, size: () => Promise<number>): Promise<MediaSide> =>
    await size() > maxMediaBytes ? { mime, tooBig: true } : { mime, data: (await read()).toString('base64') };
  const oldPath = file.oldPath ?? file.path;
  const [before, after] = await Promise.all([
    file.change === 'added' ? undefined : side(() => readGitBaseBytes(folder, oldPath, base, maxMediaBytes), async () => Number((await git(folder, ['cat-file', '-s', `${base}:${oldPath}`])).trim())),
    file.change === 'deleted' ? undefined : side(() => readFile(join(folder, file.path)), async () => (await stat(join(folder, file.path))).size),
  ]);
  return { ...before === undefined ? {} : { old: before }, ...after === undefined ? {} : { new: after } };
}
