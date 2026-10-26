import { randomUUID } from 'node:crypto';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { record } from './connection.js';

/** Replace a private runtime file atomically without inheriting old permissions. */
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (record(error)?.code !== 'ENOENT') throw error;
    });
  }
}

/** Read bounded local metadata, distinguishing missing files from invalid files. */
export async function readPrivateJson(path: string): Promise<unknown> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 65_536) throw new Error('Local Review metadata is invalid.');
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error: unknown) {
    if (record(error)?.code === 'ENOENT') return undefined;
    throw error;
  }
}
