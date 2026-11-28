import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { apply } from '../plugin/backend.mjs';
import { locations } from '../plugin/locations.mjs';
import { findWalk } from '../plugin/routes.mjs';
import { isTownState, stationaryActivity, walkingActivity } from '../plugin/town-state.mjs';

const home = { scene: 'home', point: 'home_idle', activity: 'idle' };
const produce = { scene: 'supermarket', point: 'browse_produce', activity: 'browsing_produce' };
const crossing = {
  scene: 'street_corner',
  point: 'south_crosswalk',
  activity: 'crossing',
  destination: 'supermarket',
};

test('only segments on a crosswalk count as crossing, in both directions', () => {
  const scene = 'street_corner';
  const points = [
    'from_home',
    ...findWalk(locations[scene].edges, 'from_home', 'enter_supermarket'),
  ];
  const segments = points.slice(1).map((point, index) => [points[index], point]);
  const expected = [
    ['south_crosswalk', 'crosswalk_road_south'],
    ['crosswalk_road_south', 'crosswalk_road_north'],
    ['crosswalk_road_north', 'north_crosswalk'],
    ['side_crosswalk_west', 'side_crosswalk_road_west'],
    ['side_crosswalk_road_west', 'side_crosswalk_road_east'],
    ['side_crosswalk_road_east', 'side_crosswalk_east'],
  ];
  assert.deepEqual(
    segments.filter(([from, to]) => walkingActivity(scene, from, to) === 'crossing'),
    expected,
  );
  assert.deepEqual(
    segments.filter(([from, to]) => walkingActivity(scene, to, from) === 'crossing'),
    expected,
  );
  assert.equal(walkingActivity('home', ...expected[0]), 'walking');
});

test('a visit to the market only becomes browsing at its produce marker', () => {
  assert.equal(stationaryActivity('supermarket', 'from_street'), 'idle');
  assert.equal(stationaryActivity('supermarket', 'market_aisle'), 'idle');
  assert.equal(stationaryActivity(produce.scene, produce.point), 'browsing_produce');
  assert.equal(isTownState({ ...produce, point: 'market_aisle' }), false);
  assert.equal(isTownState({ ...crossing, point: 'from_cafe' }), false);
  assert.equal(isTownState({ ...crossing, destination: 'future_store' }), false);
  assert.equal(isTownState({ ...crossing, scene: 'toString' }), false);
});

test('water and café activities stay at their actual markers and old idle rows can resume', () => {
  for (const [scene, point, activity, elsewhere] of [
    ['park', 'park_lookout', 'watching_water', 'park_lookout_approach'],
    ['cafe', 'order_at_counter', 'browsing_cafe', 'collect_coffee'],
  ]) {
    assert.equal(isTownState({ scene, point, activity: 'idle' }), true);
    assert.equal(stationaryActivity(scene, point), activity);
    assert.equal(isTownState({ scene, point, activity }), true);
    assert.equal(isTownState({ scene, point: elsewhere, activity }), false);
    assert.equal(stationaryActivity(scene, elsewhere), 'idle');
  }
});

test('at-home activities correspond to the chair, sofa and bed markers', () => {
  for (const [point, activity] of [
    ['home_breakfast', 'having_breakfast'],
    ['home_sofa', 'watching_tv'],
    ['home_bed', 'sleeping'],
  ]) {
    assert.equal(stationaryActivity('home', point), activity);
    assert.equal(isTownState({ scene: 'home', point, activity }), true);
    assert.equal(isTownState({ scene: 'home', point: 'home_idle', activity }), false);
    assert.equal(isTownState({ scene: 'home', point, activity: 'idle' }), true);
  }
});

test('only explicit residents advance, and a new roster revision invalidates old actors', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(2026, 10, 28, 12) });
  const sqlite = new DatabaseSync(':memory:');
  const library = new Map([['legacy-visitor', '旧版角色'], ['lin', '树林'], ['bai', '小白']]);
  let migrated = false;
  let dispose;
  let deleted;
  const commands = new Map();
  const tools = new Map();

  async function start() {
    await apply({
      storage: {
        async openDatabase({ name, migrations }) {
          assert.equal(name, 'town');
          if (!migrated) {
            sqlite.exec(migrations[0].sql);
            sqlite.prepare('INSERT INTO town_state VALUES (?, ?, ?, ?, ?, ?)')
              .run('legacy-visitor', 'cafe', 'order_at_counter', 'idle', null, Date.now() - 30000);
            for (const { sql } of migrations.slice(1)) sqlite.exec(sql);
            migrated = true;
          }
          return {
            async run(sql, args = []) {
              return sqlite.prepare(sql).run(...args);
            },
            async get(sql, args = []) {
              return sqlite.prepare(sql).get(...args);
            },
            async all(sql, args = []) {
              return sqlite.prepare(sql).all(...args);
            },
            async transaction(statements) {
              sqlite.exec('BEGIN');
              try {
                const results = statements.map(({ sql, params = [], result = 'run' }) =>
                  sqlite.prepare(sql)[result](...params),
                );
                sqlite.exec('COMMIT');
                return results;
              } catch (error) {
                sqlite.exec('ROLLBACK');
                throw error;
              }
            },
          };
        },
      },
      townCharacters: {
        async list(ids) {
          return ids.filter((id) => library.has(id)).map((characterId) =>
            ({ characterId, name: library.get(characterId) }),
          );
        },
        onDeleted(listener) {
          deleted = listener;
          return () => { deleted = undefined; };
        },
      },
      onDispose: (handler) => { dispose = handler; },
      commands: { register: (name, handler) => commands.set(name, handler) },
      tools: { register: (name, handler) => tools.set(name, handler) },
    });
  }

  const run = (name, payload) => commands.get(name)(payload);
  const signal = new AbortController().signal;
  const actor = (characterId, residentGeneration, executionId) =>
    ({ characterId, residentGeneration, executionId, signal });
  const tick = async (ms) => {
    t.mock.timers.tick(ms);
    await new Promise((resolve) => setImmediate(resolve));
  };
  t.after(() => {
    dispose?.();
    sqlite.close();
  });
  await start();

  assert.deepEqual(await run('list-town-residents'), { revision: 0, residents: [] });
  assert.equal(await run('read-town-state', { characterId: 'legacy-visitor' }), null);
  assert.equal(await run('read-town-view', { characterId: 'lin' }), null);
  assert.equal(await run('set-town-paused', { characterId: 'lin', paused: true }), null);
  await assert.rejects(run('set-town-residents', { revision: 0, characterIds: ['lin', 'unknown'] }),
    /invalid-town-resident/);
  assert.deepEqual(await run('list-town-residents'), { revision: 0, residents: [] });
  const [selected, concurrent] = await Promise.all([
    run('set-town-residents', { revision: 0, characterIds: ['lin', 'bai'] }),
    run('set-town-residents', { revision: 0, characterIds: ['bai'] }),
  ]);
  assert.deepEqual(selected, { revision: 1, residents: [
    { characterId: 'lin', name: '树林' }, { characterId: 'bai', name: '小白' },
  ] });
  assert.deepEqual(concurrent, { ...selected, conflict: true });
  assert.deepEqual(await run('set-town-residents', { revision: 0, characterIds: [] }),
    { ...selected, conflict: true });
  assert.equal((await run('read-town-state', { characterId: 'lin' })).residentGeneration, 1);
  const beforeQueries = sqlite.prepare('SELECT journey_json FROM town_state WHERE character_id=?').get('lin').journey_json;
  assert.deepEqual(await tools.get('list_residents')({}, actor('lin', 1)), selected.residents);
  assert.equal((await tools.get('get_resident_state')({ resident_id: 'bai' }, actor('lin', 1))).residentGeneration, undefined);
  assert.equal(await tools.get('get_resident_state')({ resident_id: 'legacy-visitor' }, actor('lin', 1)), null);
  const cafe = await tools.get('list_activities')({ scene: 'cafe' }, actor('lin', 1));
  assert.equal(cafe.activities[0].id, 'browsing_cafe');
  assert.equal(sqlite.prepare('SELECT journey_json FROM town_state WHERE character_id=?').get('lin').journey_json, beforeQueries);
  library.set('bai', '白树');
  assert.equal((await run('list-town-residents')).residents[1].name, '白树');

  const go = { activity: 'watching_water' };
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(tools.get('do_activity')(go, {
    ...actor('lin', 1, 'cancelled-turn'), signal: stopped.signal,
  }), { name: 'AbortError' });
  assert.equal(sqlite.prepare('SELECT count(*) AS total FROM town_receipts').get().total, 0);
  const accepted = await tools.get('do_activity')(go, actor('lin', 1, 'turn-1'));
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.current.scene, 'home');
  assert.notEqual(accepted.current.activity, 'watching_water');
  assert.deepEqual(await tools.get('do_activity')(go, actor('lin', 1, 'turn-1')), accepted);
  assert.deepEqual(await tools.get('go_to')({ location: 'cafe' }, actor('lin', 1, 'turn-1')), { status: 'conflict' });
  assert.deepEqual(await tools.get('go_to')({ location: 'cafe', resident_id: 'bai' }, actor('lin', 1, 'turn-2')), { status: 'invalid_input' });
  assert.equal((await run('set-town-paused', { characterId: 'bai', paused: true })).paused, true);
  assert.equal((await tools.get('go_to')({ location: 'cafe' }, actor('bai', 1, 'paused-turn'))).status, 'paused');

  const pointBeforeRestart = (await run('read-town-state', { characterId: 'lin' })).point;
  dispose();
  await start();
  assert.equal((await run('read-town-state', { characterId: 'lin' })).point, pointBeforeRestart);
  assert.deepEqual(await tools.get('do_activity')(go, actor('lin', 1, 'turn-1')), accepted);
  const stateRow = sqlite.prepare('SELECT scene, point, activity, paused FROM town_state WHERE character_id=?');
  for (let i = 0; i < 100 && stateRow.get('lin').activity !== 'watching_water'; i++) await tick(1000);
  assert.deepEqual({ ...stateRow.get('lin') },
    { scene: 'park', point: 'park_lookout', activity: 'watching_water', paused: 0 });
  assert.deepEqual({ ...stateRow.get('bai') }, { ...home, paused: 1 });

  await run('set-town-residents', { revision: 1, characterIds: ['bai'] });
  await tick(60000);
  assert.equal(await run('read-town-view', { characterId: 'lin' }), null);
  assert.equal(stateRow.get('lin').point, 'park_lookout');
  await run('set-town-residents', { revision: 2, characterIds: ['bai', 'lin'] });
  const returned = await run('read-town-state', { characterId: 'lin' });
  assert.equal(returned.residentGeneration, 3);
  assert.equal(returned.point, 'home_idle');
  assert.deepEqual(await tools.get('do_activity')(go, actor('lin', 1, 'stale')),
    { status: 'not_resident' });
  library.delete('lin');
  assert.equal(await tools.get('get_resident_state')({ resident_id: 'lin' }, actor('bai', 1)), null);
  await deleted();
  assert.equal(await run('read-town-state', { characterId: 'lin' }), null);
  assert.deepEqual(await run('list-town-residents'), {
    revision: 4, residents: [{ characterId: 'bai', name: '白树' }],
  });
});
