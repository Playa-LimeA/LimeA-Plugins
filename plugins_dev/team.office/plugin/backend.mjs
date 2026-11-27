import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const maxBytes = 32 * 1024 * 1024;
const mediaFile = /^tv-[0-9a-f-]{36}\.mp4$/;

export async function apply(ctx) {
  if (!ctx.dataDirectory) return;
  const folder = join(ctx.dataDirectory, 'screen');
  const configPath = join(folder, 'current.json');
  let current = null;
  let candidate = null;
  let closed = false;
  let commands = Promise.resolve();

  ctx.onDispose(() => {
    closed = true;
  });
  await mkdir(folder, { recursive: true });

  async function writeSelection(selection) {
    const temporary = join(folder, 'current.tmp');
    await writeFile(temporary, JSON.stringify({ selection }));
    await rename(temporary, configPath);
  }

  function removeMedia(file) {
    return rm(join(folder, file), { force: true }).catch(() => {});
  }

  async function readSelection() {
    try {
      const { selection } = JSON.parse(await readFile(configPath, 'utf8'));
      if (selection === null || (mediaFile.test(selection?.file) && typeof selection.name === 'string')) {
        current = selection;
        return true;
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        await writeSelection(null);
        return true;
      }
    }
    return false;
  }

  if (await readSelection()) {
    const files = await readdir(folder);
    await Promise.all(files.filter((file) => mediaFile.test(file) && file !== current?.file).map(removeMedia));
  }

  function register(method, action) {
    ctx.commands.register(method, (payload) => {
      const result = commands.then(() => closed ? { canceled: true } : action(payload));
      commands = result.catch(() => {});
      return result;
    });
  }

  register('screen-state', () => ({ selection: current }));

  register('screen-choose', async () => {
    const picked = await ctx.dialog.pickFile([{ name: 'MP4', extensions: ['mp4'] }]);
    if (closed || picked.status !== 'selected') return { canceled: true };
    if (extname(picked.path).toLowerCase() !== '.mp4') return { error: 'format' };

    const file = 'tv-' + randomUUID() + '.mp4';
    let inputFile;
    try {
      inputFile = await open(picked.path, 'r');
      const info = await inputFile.stat();
      if (!info.isFile() || info.size === 0) return { error: 'format' };
      if (info.size > maxBytes) return { error: 'size' };
      const input = inputFile.createReadStream({ autoClose: false, end: info.size - 1 });
      await pipeline(input, createWriteStream(join(folder, file), { flags: 'wx' }));
      const after = await inputFile.stat();
      if (input.bytesRead !== info.size || info.size !== after.size || info.mtimeMs !== after.mtimeMs) {
        await removeMedia(file);
        return { error: 'read' };
      }
      if (closed) {
        await removeMedia(file);
        return { canceled: true };
      }
      if (candidate) await removeMedia(candidate.file);
      candidate = { file, name: basename(picked.path) };
      return { candidate };
    } catch {
      await removeMedia(file);
      return { error: 'read' };
    } finally {
      await inputFile?.close().catch(() => {});
    }
  });

  register('screen-discard', async (file) => {
    if (candidate && candidate.file === file) {
      candidate = null;
      await removeMedia(file);
    }
    return null;
  });

  async function publish(selection) {
    const previous = current;
    await writeSelection(selection);
    current = selection;
    if (previous) await removeMedia(previous.file);
    return { selection };
  }

  register('screen-save', async (file) => {
    if (!candidate || candidate.file !== file) return { error: 'changed' };
    const result = await publish(candidate);
    candidate = null;
    return result;
  });
  register('screen-clear', async () => {
    const result = await publish(null);
    if (candidate) {
      await removeMedia(candidate.file);
      candidate = null;
    }
    return result;
  });
}
