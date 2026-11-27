import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createOfficeActivity } from '../plugin/activity.mjs';
import { activities, areaAt, makeRoute } from '../plugin/office-routes.mjs';

const layout = JSON.parse(
  readFileSync(new URL('../plugin/assets/standard-scene.json', import.meta.url), 'utf8'),
);
const timing = {
  initialDelay: [50, 50],
  activityDuration: [5000, 5000],
  visitDuration: [5000, 5000],
  movementSpeed: 7,
};

function setup(options = {}) {
  let current = 0;
  let serial = 0;
  let calls = 0;
  const queue = new Map();
  const schedule = (callback, delay) => {
    queue.set(++serial, [current + delay, callback]);
    return serial;
  };
  const cancel = (handle) => queue.delete(handle);
  const state = createOfficeActivity(layout, () => calls++, {
    random: () => 0.9,
    timing,
    now: () => current,
    setTimer: schedule,
    clearTimer: cancel,
    requestFrame: (callback) => schedule(callback, 16),
    cancelFrame: cancel,
    ...options,
  });
  return {
    state,
    advance(milliseconds) {
      const deadline = current + milliseconds;
      while (queue.size) {
        const [id, [at, callback]] = [...queue].sort((a, b) => a[1][0] - b[1][0])[0];
        if (at > deadline) break;
        current = at;
        queue.delete(id);
        callback();
      }
      current = deadline;
    },
    get calls() {
      return calls;
    },
  };
}

test('the 24 actions cover each area and keep window and neighboring desks distinct', () => {
  assert.equal(activities.length, 24);
  assert.equal(new Set(activities.map(({ text }) => text[0])).size, 24);
  const [first, neighbor] = layout.seats;
  const routeTo = (type) =>
    makeRoute(
      first,
      activities.find((activity) => activity.type === type),
      neighbor,
    );
  assert.equal(areaAt(routeTo('neighbor').at(-1))[0], 'A 区');
  assert.equal(areaAt(routeTo('window').at(-1))[0], '窗边长椅');
  assert.equal(areaAt(routeTo('lounge').at(-1))[0], '休闲区');
  assert.equal(areaAt(routeTo('pantry').at(-1))[0], '水吧区');
});

test('new real activity overrides simulated text and reverses the path home', () => {
  const clock = setup();
  const { state } = clock;
  const member = { id: 'member', seatId: 'A1', activity: 'idle' };
  state.setMembers([member]);
  state.setVisible(true);
  clock.advance(1000);
  const away = state.get('member');
  assert.ok(away.position);
  assert.match(away.action[0], /走/);
  state.setMembers([{ ...member, activity: 'working' }]);
  assert.equal(state.get('member').action, null);
  assert.ok(state.get('member').position);
  clock.advance(200);
  const returning = state.get('member').position;
  assert.ok(returning[0] < away.position[0]);
  clock.advance(2500);
  assert.deepEqual(state.get('member'), { position: null, area: ['A 区', 'A zone'], action: null });
  state.dispose();
});

test('visibility pauses concurrent walks and status unknown remains still', () => {
  const clock = setup();
  const { state } = clock;
  const members = [
    { id: 'a', seatId: 'A1', activity: 'idle' },
    { id: 'b', seatId: 'A2', activity: 'idle' },
    { id: 'c', seatId: 'B1', activity: 'idle' },
    { id: 'd', seatId: 'B2', activity: 'unknown' },
  ];
  state.setMembers(members);
  state.setVisible(true);
  clock.advance(1100);
  assert.equal(members.filter((member) => state.get(member.id).position).length, 3);
  assert.deepEqual(state.get('d'), { position: null, area: ['B 区', 'B zone'], action: null });
  const before = state.get('a').position;
  const calls = clock.calls;
  state.setVisible(false);
  clock.advance(50000);
  assert.deepEqual(state.get('a').position, before);
  assert.equal(clock.calls, calls);
  state.setVisible(true);
  clock.advance(32);
  const resumed = state.get('a').position;
  assert.ok(Math.hypot(...resumed.map((coord, axis) => coord - before[axis])) < 0.4);
  state.dispose();
});

test('all 12 floor members can walk at the same time', () => {
  const clock = setup();
  const { state } = clock;
  const members = layout.seats.map(({ id }) => ({ id, seatId: id, activity: 'idle' }));
  assert.equal(members.length, 12);
  state.setMembers(members);
  state.setVisible(true);
  clock.advance(66);
  const positions = members.map(({ id }) => state.get(id).position);
  clock.advance(64);
  for (const [index, { id }] of members.entries()) {
    assert.ok(positions[index]);
    assert.notDeepEqual(state.get(id).position, positions[index]);
  }
  state.dispose();
});

test('desk activities do not repeat and reduced motion uses only destination updates', () => {
  const first = setup({ random: () => 0 });
  const member = { id: 'a', seatId: 'B1', activity: 'idle' };
  first.state.setMembers([member]);
  first.state.setVisible(true);
  const chosen = first.state.get('a').action;
  first.advance(50);
  assert.notDeepEqual(first.state.get('a').action, chosen);
  first.state.dispose();

  const reduced = setup({
    reducedMotion: true,
    requestFrame: () => assert.fail('reduced motion must not request animation frames'),
  });
  reduced.state.setMembers([member]);
  reduced.state.setVisible(true);
  reduced.advance(50);
  assert.ok(reduced.state.get('a').position);
  assert.equal(reduced.state.get('a').area[0], '主过道');
  reduced.state.setMembers([{ ...member, activity: 'replying' }]);
  assert.equal(reduced.state.get('a').position, null);
  assert.equal(reduced.state.get('a').action, null);
  reduced.state.dispose();
});
