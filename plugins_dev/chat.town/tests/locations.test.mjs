import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { destinationOrder, locations } from '../plugin/locations.mjs';
import { findWalk, getPortal, nextStop } from '../plugin/routes.mjs';

async function assetMarkers(id) {
  const payload = await readFile(new URL(`../plugin/assets/${id}.glb`, import.meta.url));
  assert.equal(payload.toString('ascii', 0, 4), 'glTF');
  const jsonEnd = 20 + payload.readUInt32LE(12);
  const { nodes } = JSON.parse(payload.toString('utf8', 20, jsonEnd));
  const points = new Map();
  for (const { extras } of nodes) {
    if (extras?.scene_id !== id || !extras.point_id) continue;
    assert.equal(points.has(extras.point_id), false, `duplicate ${id}/${extras.point_id}`);
    points.set(extras.point_id, extras);
  }
  return points;
}

test('each pair of locations connects through its entrance and an accessible visit point', async () => {
  const markers = new Map(
    await Promise.all(destinationOrder.map(async (id) => [id, await assetMarkers(id)])),
  );
  for (const start of destinationOrder) {
    const visit = locations[start].visit;
    assert.ok(markers.get(start).has(visit));
    for (const [from, to] of locations[start].edges) {
      assert.ok(markers.get(start).has(from), `missing route marker ${start}/${from}`);
      assert.ok(markers.get(start).has(to), `missing route marker ${start}/${to}`);
    }
    for (const destination of destinationOrder) {
      let current = start;
      let position = visit;
      for (let doors = 0; current !== destination; doors++) {
        assert.ok(doors < 2, `${start} → ${destination} went through too many doors`);
        const { point, next } = nextStop(locations, current, destination);
        findWalk(locations[current].edges, position, point);
        position = getPortal(markers.get(current), point, next);
        assert.ok(markers.get(next).has(position), `missing ${next}/${position}`);
        current = next;
      }
      findWalk(locations[destination].edges, position, locations[destination].visit);
    }
  }
});

test('the home route crosses the main street and both shops use the second crossing', () => {
  const { edges } = locations.street_corner;
  for (const shop of ['enter_bakery', 'enter_supermarket']) {
    const route = findWalk(edges, 'from_home', shop);
    assert.equal(route[0], 'home_door_bypass');
    const crossings = route.filter((point) => point.includes('road_'));
    assert.deepEqual(crossings, [
      'crosswalk_road_south',
      'crosswalk_road_north',
      'side_crosswalk_road_west',
      'side_crosswalk_road_east',
    ]);
  }
});

test('disconnected walking points and disabled doors fail without a route', () => {
  assert.throws(() => findWalk([['from', 'aisle']], 'from', 'finish'), /No walking route/);
  const markers = new Map([
    ['door', { connection_ready: false, target_scene: 'shop', arrival_point: 'from_street' }],
  ]);
  assert.throws(() => getPortal(markers, 'door', 'shop'), /disconnected/);
});
