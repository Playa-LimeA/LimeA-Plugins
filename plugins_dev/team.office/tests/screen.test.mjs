import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, truncate, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { apply } from '../plugin/backend.mjs';

async function start(dataDirectory) {
  const commands = new Map();
  let picked = { status: 'canceled' };
  let dispose;
  await apply({
    dataDirectory,
    dialog: { pickFile: () => picked },
    commands: { register: (name, handler) => commands.set(name, handler) },
    onDispose: (callback) => { dispose = callback; },
  });
  return {
    call: (name, payload) => commands.get('screen-' + name)(payload),
    pick: (path) => { picked = { status: 'selected', path }; },
    close: dispose,
  };
}

test('publishes only the validated candidate and preserves the selection across restarts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'limea-office-tv-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const media = join(root, 'media');
  const first = join(root, 'first.mp4');
  const second = join(root, 'second.mp4');
  await writeFile(first, 'first source');
  await writeFile(second, 'second source');
  const office = await start(media);
  assert.deepEqual(await office.call('choose'), { canceled: true });

  office.pick(first);
  const { candidate: a } = await office.call('choose');
  assert.deepEqual(await office.call('state'), { selection: null });
  assert.equal(await readFile(join(media, 'screen', a.file), 'utf8'), 'first source');
  assert.deepEqual(await office.call('save', a.file), { selection: a });

  office.pick(second);
  const { candidate: b } = await office.call('choose');
  await office.call('discard', b.file);
  assert.deepEqual(await office.call('save', b.file), { error: 'changed' });
  assert.deepEqual(await office.call('state'), { selection: a });
  office.pick(second);
  const { candidate: unused } = await office.call('choose');
  office.close();
  assert.deepEqual(await office.call('save', unused.file), { canceled: true });

  const reopened = await start(media);
  assert.deepEqual(await reopened.call('state'), { selection: a });
  assert.deepEqual((await readdir(join(media, 'screen'))).sort(), ['current.json', a.file].sort());
  reopened.pick(second);
  const { candidate: stale } = await reopened.call('choose');
  assert.deepEqual(await reopened.call('clear'), { selection: null });
  assert.deepEqual(await reopened.call('save', stale.file), { error: 'changed' });
  assert.deepEqual(await readdir(join(media, 'screen')), ['current.json']);
});

test('rejects incorrect extensions and over-limit input before creating a candidate', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'limea-office-tv-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const source = join(root, 'large.mp4');
  await writeFile(source, 'video');
  await truncate(source, 32 * 1024 * 1024 + 1);
  const office = await start(join(root, 'media'));
  office.pick(join(root, 'unrecognized.webm'));
  assert.deepEqual(await office.call('choose'), { error: 'format' });
  office.pick(source);
  assert.deepEqual(await office.call('choose'), { error: 'size' });
  assert.deepEqual(await readdir(join(root, 'media', 'screen')), ['current.json']);
});
