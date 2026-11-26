import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandlers, normalizeFsidsParam } from '../src/backend.mjs';

test('normalizes 64-bit integer string fsids without precision loss and rejects invalid items', () => {
  assert.equal(normalizeFsidsParam(['110238770066592812', 42]), '[110238770066592812,42]');
  assert.throws(() => normalizeFsidsParam([]));
  assert.throws(() => normalizeFsidsParam(['0']));
  assert.throws(() => normalizeFsidsParam(['abc']));
});

test('formats quota and projects file listings cleanly without leaking dlink', async () => {
  const calls = [];
  const context = {
    connections: {
      async request(req) {
        calls.push(req);
        if (req.url.includes('/api/quota')) {
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({ errno: 0, total: 10 * 1024 ** 3, used: 2 * 1024 ** 3 }),
          };
        }
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            errno: 0,
            list: [
              {
                fs_id: 998877,
                path: '/apps/LimeA/report.pdf',
                server_filename: 'report.pdf',
                isdir: 0,
                size: 2048,
                category: 4,
                server_mtime: 1700000000,
                dlink: 'https://should-not-pass',
              },
            ],
          }),
        };
      },
    },
  };
  const handlers = createHandlers();
  const quota = await handlers.get_quota({}, context);
  assert.equal(quota.totalLabel, '10.00 GB');
  assert.equal(quota.freeLabel, '8.00 GB');

  const listing = await handlers.list_files({ dir: '/apps/LimeA', limit: 20 }, context);
  assert.equal(listing.count, 1);
  assert.equal(listing.files[0].category, '文档');
  assert.equal(listing.files[0].sizeLabel, '2.00 KB');
  assert.equal('dlink' in listing.files[0], false);
  assert.match(calls[1].url, /method=list/);
  assert.doesNotMatch(calls[1].url, /access_token=/);
});

test('sends canonical semantic write paths for create_folder and delete_files', async () => {
  const requests = [];
  const context = {
    connections: {
      async request(req) {
        requests.push(req);
        return { status: 200, headers: {}, body: JSON.stringify({ errno: 0, fs_id: 777 }) };
      },
    },
  };
  const handlers = createHandlers();
  const created = await handlers.create_folder({ path: '/apps/LimeA/Docs' }, context);
  assert.equal(created.created, true);
  assert.equal(requests[0].url, 'https://pan.baidu.com/rest/2.0/xpan/file/create_dir');
  assert.deepEqual(JSON.parse(requests[0].body), { path: '/apps/LimeA/Docs' });

  const deleted = await handlers.delete_files({ paths: ['/apps/LimeA/old.txt'] }, context);
  assert.equal(deleted.deleted, true);
  assert.equal(requests[1].url, 'https://pan.baidu.com/rest/2.0/xpan/file/delete');
  assert.deepEqual(JSON.parse(requests[1].body), { paths: ['/apps/LimeA/old.txt'] });
});
