import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTownJourney } from '../plugin/journey.mjs';
import { calendarDay, chooseRoutineActivity, makePreferences } from '../plugin/routine.mjs';
import { navigation } from '../plugin/navigation.mjs';
import { markerNavigation, readNavigation } from '../src/generate-navigation.mjs';
import { activityCatalog, isTownState, walkingActivity } from '../plugin/town-state.mjs';

const localTime = (hour, minute = 0, second = 0, millisecond = 0, day = 28) =>
  new Date(2026, 10, day, hour, minute, second, millisecond).getTime();
const start = localTime(14);

function untilActivity(journey, initial, activity) {
  let state = initial;
  for (let steps = 0; steps < 120; steps++) {
    if (state.activity === activity) return state;
    assert.ok(state.nextAt !== null);
    state = journey.read(state.nextAt);
  }
  assert.fail(`did not reach ${activity}`);
}

test('generated navigation matches the seven binary models and uses world coordinates', async () => {
  assert.deepEqual(navigation, await readNavigation());
  const markers = markerNavigation({
    scenes: [{ nodes: [0] }],
    nodes: [
      {
        translation: [10, 3, 0],
        rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
        scale: [2, 2, 2],
        children: [1, 2],
      },
      {
        translation: [1, 0, 0],
        extras: { scene_id: 'home', point_id: 'first' },
      },
      {
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1],
        extras: { scene_id: 'home', point_id: 'door', target_scene: 'street_corner', arrival_point: 'from_home' },
      },
    ],
  }, 'home');
  assert.deepEqual(markers.get('first').position, [10, 3, -2]);
  assert.deepEqual(markers.get('door'), {
    position: [10, 3, -4],
    target_scene: 'street_corner',
    arrival_point: 'from_home',
  });
});

const homeOnly = { seed: 17, wake: 360, bed: 1260, outing: 0 };

test('auto activity starts only on arrival and uses absolute walking deadlines', () => {
  const journey = makeTownJourney(null, start, { preference: homeOnly });
  const resting = journey.read(start + 5999);
  assert.deepEqual(resting, {
    scene: 'home', point: 'home_idle', activity: 'idle', paused: false, nextAt: start + 6000,
  });
  let state = journey.read(start + 6000);
  const expected = chooseRoutineActivity({
    preference: homeOnly, at: start + 6000, scene: 'home', recent: [], sequence: 0,
  });
  assert.equal(state.activity, 'walking');
  assert.equal(state.destination, 'home');
  assert.equal(state.point, 'home_idle');
  assert.equal(state.motion.startsAt, start + 6000);
  const firstFrom = navigation.home.home_idle.position;
  const firstTo = navigation.home[state.motion.to].position;
  const duration = Math.max(100, Math.round(Math.hypot(
    ...firstFrom.map((value, index) => value - firstTo[index]),
  ) * 1000 / 3.5));
  assert.equal(state.motion.endsAt, state.motion.startsAt + duration);
  assert.deepEqual(journey.read(state.motion.endsAt - 1), state);
  while (state.motion) {
    const prior = state.motion;
    state = journey.read(state.nextAt);
    assert.equal(state.point, prior.to);
    assert.equal(isTownState(state), true);
  }
  assert.equal(state.activity, expected);
  assert.equal(state.point, activityCatalog[expected].point);
});

test('pausing a wait retains its remaining time and pausing movement retains its point', () => {
  const journey = makeTownJourney(null, start, { preference: homeOnly });
  const waiting = journey.setPaused(true, start + 2000);
  assert.equal(waiting.point, 'home_idle');
  assert.equal(waiting.nextAt, null);
  assert.equal(waiting.paused, true);
  const resumedAt = start + 200000;
  assert.deepEqual(journey.read(resumedAt), waiting);
  assert.equal(journey.setPaused(false, resumedAt).nextAt, resumedAt + 4000);
  const first = journey.read(resumedAt + 4000);
  const halted = journey.setPaused(true, first.motion.startsAt + 1);
  assert.equal(halted.point, first.motion.from);
  assert.equal(halted.activity, 'idle');
  assert.equal(halted.motion, undefined);
  const resumed = journey.setPaused(false, resumedAt + 4500);
  assert.equal(resumed.motion.from, first.motion.from);
  assert.equal(resumed.motion.to, first.motion.to);
  assert.equal(resumed.motion.startsAt, resumedAt + 4500);
});

test('an automatic crossing finishes on the far curb before a bedtime change turns it back', () => {
  const at = localTime(21) - 1;
  const initial = makeTownJourney({
    scene: 'street_corner', point: 'south_crosswalk', activity: 'idle',
  }, at, { preference: homeOnly });
  initial.setAction({ scene: 'park', point: 'park_lookout', activity: 'watching_water' }, at);
  const checkpoint = JSON.parse(JSON.stringify(initial.checkpoint()));
  checkpoint.goal.manual = false;
  checkpoint.goal.until = at + 1;
  const journey = makeTownJourney(null, at, { preference: homeOnly, checkpoint });
  let state = journey.read(at);
  for (const point of ['south_crosswalk', 'crosswalk_road_south', 'crosswalk_road_north']) {
    assert.equal(state.point, point);
    assert.equal(state.activity, 'crossing');
    assert.equal(state.destination, 'park');
    state = journey.read(state.nextAt);
  }
  assert.equal(state.point, 'north_crosswalk');
  assert.equal(state.destination, 'home');
  const asleep = untilActivity(journey, state, 'sleeping');
  assert.equal(asleep.point, 'home_bed');
  assert.equal(asleep.nextAt, localTime(6, 0, 0, 0, 29));
});

test('personal sleep is tied to local wake time across a long clock jump', () => {
  const bedtime = localTime(22);
  const morning = localTime(7, 0, 0, 0, 30);
  const journey = makeTownJourney({
    scene: 'home', point: 'home_bed', activity: 'idle',
  }, bedtime, { preference: homeOnly });
  const asleep = untilActivity(journey, journey.read(bedtime), 'sleeping');
  assert.equal(asleep.nextAt, localTime(6, 0, 0, 0, 29));
  const change = journey.read(morning);
  assert.equal(change.point, 'home_bed');
  assert.equal(change.activity, 'walking');
  assert.equal(change.destination, 'home');
  assert.equal(change.motion.startsAt, morning);
  assert.ok(change.nextAt > morning);
});

test('normal late reads consume the same steps as on-time reads', () => {
  const delayed = makeTownJourney(null, start, { preference: homeOnly });
  const stepped = makeTownJourney(null, start, { preference: homeOnly });
  const late = start + 24000;
  let state = stepped.read(start);
  while (state.nextAt <= late) state = stepped.read(state.nextAt);
  assert.deepEqual(delayed.read(late), stepped.read(late));
});

test('breakfast completion persists and suppresses another automatic breakfast that morning', () => {
  const at = localTime(9);
  const journey = makeTownJourney({ scene: 'home', point: 'home_breakfast', activity: 'idle' }, at,
    { preference: homeOnly });
  const breakfast = journey.setAction({ scene: 'home', point: 'home_breakfast', activity: 'having_breakfast' }, at);
  assert.equal(breakfast.status, 'started');
  assert.equal(breakfast.snapshot.activity, 'having_breakfast');
  const checkpoint = JSON.parse(JSON.stringify(journey.checkpoint()));
  assert.equal(checkpoint.breakfastDay, calendarDay(at));
  const reopened = makeTownJourney(null, at + 5000, { preference: homeOnly, checkpoint, restart: true });
  assert.equal(reopened.read(at + 5000).nextAt, breakfast.snapshot.nextAt);
  let state = reopened.read(breakfast.snapshot.nextAt);
  while (state.nextAt < localTime(11)) {
    assert.notEqual(state.activity, 'having_breakfast');
    state = reopened.read(state.nextAt);
  }
});

test('a requested turn survives restart and starts only after reaching the curb', () => {
  const preference = makePreferences('lin');
  const journey = makeTownJourney({
    scene: 'street_corner', point: 'south_crosswalk', activity: 'idle',
  }, start, { preference });
  const initial = journey.setAction({ scene: 'park', point: 'park_lookout', activity: 'watching_water' }, start);
  assert.equal(initial.snapshot.activity, 'crossing');
  const waiting = journey.setAction({ scene: 'cafe', point: 'order_at_counter' }, start + 10);
  assert.equal(waiting.snapshot.destination, 'park');
  const reloaded = makeTownJourney(null, start + 50000, {
    preference, checkpoint: JSON.parse(JSON.stringify(journey.checkpoint())), restart: true,
  });
  let snapshot = reloaded.read(start + 50000);
  assert.equal(snapshot.motion.startsAt, start + 50000);
  for (const point of ['south_crosswalk', 'crosswalk_road_south', 'crosswalk_road_north']) {
    assert.equal(snapshot.point, point);
    assert.equal(snapshot.activity, 'crossing');
    assert.equal(snapshot.destination, 'park');
    snapshot = reloaded.read(snapshot.nextAt);
  }
  assert.equal(snapshot.point, 'north_crosswalk');
  assert.equal(snapshot.destination, 'cafe');
  while (snapshot.motion) snapshot = reloaded.read(snapshot.nextAt);
  assert.equal(snapshot.scene, 'cafe');
  assert.equal(snapshot.point, 'order_at_counter');
  assert.equal(snapshot.activity, 'idle');
});

test('changing A to B and back to A during a crossing honors the latest command', () => {
  const a = { scene: 'park', point: 'park_lookout', activity: 'watching_water' };
  const b = { scene: 'cafe', point: 'order_at_counter', activity: 'browsing_cafe' };
  const journey = makeTownJourney({
    scene: 'street_corner', point: 'south_crosswalk', activity: 'idle',
  }, start, { preference: homeOnly });
  assert.equal(journey.setAction(a, start).snapshot.activity, 'crossing');
  assert.equal(journey.setAction(b, start + 10).status, 'accepted');
  assert.equal(journey.setAction(a, start + 20).status, 'accepted');
  const arrived = untilActivity(journey, journey.read(start + 20), 'watching_water');
  assert.equal(arrived.scene, 'park');
  assert.equal(arrived.point, 'park_lookout');
});

test('manual sofa rest and television use the same point and preserve the chosen activity', () => {
  const preference = makePreferences('lin');
  const journey = makeTownJourney({
    scene: 'home', point: 'home_sofa', activity: 'idle',
  }, start, { preference });
  const rest = journey.setAction({ scene: 'home', point: 'home_sofa', activity: 'resting_sofa' }, start);
  assert.equal(rest.status, 'started');
  assert.equal(rest.snapshot.activity, 'resting_sofa');
  const same = journey.setAction({ scene: 'home', point: 'home_sofa', activity: 'resting_sofa' }, start + 10);
  assert.equal(same.snapshot.nextAt, rest.snapshot.nextAt);
  const watch = journey.setAction({ scene: 'home', point: 'home_sofa', activity: 'watching_tv' }, start + 20);
  assert.equal(watch.status, 'started');
  assert.equal(watch.snapshot.point, rest.snapshot.point);
  assert.equal(watch.snapshot.activity, 'watching_tv');
  assert.equal(isTownState(watch.snapshot), true);
});
