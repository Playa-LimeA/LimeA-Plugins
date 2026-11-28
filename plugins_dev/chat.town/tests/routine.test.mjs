import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activityDwell, calendarDay, chooseRoutineActivity, homeSchedule, makePreferences,
} from '../plugin/routine.mjs';
import { activityCatalog } from '../plugin/town-state.mjs';

const local = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();

test('local wake, morning, afternoon and bedtime have distinct windows', () => {
  const preference = { ...makePreferences('lin'), wake: 390, bed: 1290 };
  assert.deepEqual(homeSchedule(local(28, 6, 29), preference), {
    sleeping: true, endsAt: local(28, 6, 30),
  });
  assert.equal(homeSchedule(local(28, 6, 30), preference).endsAt, local(28, 11));
  assert.equal(homeSchedule(local(28, 11), preference).endsAt, local(28, 18));
  assert.equal(homeSchedule(local(28, 18), preference).endsAt, local(28, 21, 30));
  assert.deepEqual(homeSchedule(local(28, 21, 30), preference), {
    sleeping: true, endsAt: local(29, 6, 30),
  });
});

test('overnight sleep ends at the local wake time through daylight saving', () => {
  const evening = new Date(2026, 2, 7, 22).getTime();
  assert.equal(homeSchedule(evening).endsAt, new Date(2026, 2, 8, 6).getTime());
});

test('dwell times use different minute intervals', () => {
  const preference = makePreferences('lin');
  const at = local(28, 15);
  for (const [activity, min, max] of [
    ['having_breakfast', 4, 8], ['watching_street', 3, 7], ['watching_tv', 7, 18],
    ['resting_sofa', 7, 18], ['using_computer', 12, 25], ['watching_water', 5, 15],
    ['browsing_bread', 5, 15], ['idle', 2, 6],
  ]) {
    const dwell = activityDwell(preference, at, 4, activity);
    assert.ok(dwell >= min * 60000 && dwell < max * 60000, activity);
    assert.equal(activityDwell(preference, at, 4, activity), dwell);
  }
});

test('personal preferences and daytime choices vary across people and dates', () => {
  const first = makePreferences('lin');
  const second = makePreferences('bai');
  assert.deepEqual(makePreferences('lin'), first);
  assert.notDeepEqual(first, second);
  const choices = (preference) => Array.from({ length: 8 }, (_, day) => {
    const args = { preference, at: local(20 + day, 15), scene: 'home', sequence: 0, recent: [] };
    const result = chooseRoutineActivity(args);
    assert.equal(chooseRoutineActivity(args), result);
    return result;
  });
  assert.notDeepEqual(choices(first), choices(second));
  assert.ok(new Set(choices(first)).size > 1);
  for (const hour of [3, 23]) {
    assert.equal(chooseRoutineActivity({
      preference: first, at: local(28, hour), scene: 'street_corner', recent: [], sequence: 2,
    }), 'sleeping');
  }
});

test('an entire afternoon can stay at home and another date can include outings', () => {
  const preference = makePreferences('lin');
  let afternoonAtHome = 0;
  let afternoonsWithOutings = 0;
  for (let day = 1; day <= 24; day++) {
    const scenes = Array.from({ length: 25 }, (_, sequence) =>
      activityCatalog[chooseRoutineActivity({
        preference, at: local(day, 15), scene: 'home', recent: [], sequence,
      })].scene,
    );
    if (scenes.every((scene) => scene === 'home')) afternoonAtHome++;
    else afternoonsWithOutings++;
  }
  assert.ok(afternoonAtHome > 0);
  assert.ok(afternoonsWithOutings > 0);
});

test('recently visiting the market reduces its weight and breakfast does not repeat', () => {
  const preference = makePreferences('lin');
  let baseline = 0;
  let repeated = 0;
  for (let sequence = 0; sequence < 800; sequence++) {
    const args = { preference, at: local(28, 19), scene: 'home', sequence };
    if (chooseRoutineActivity({ ...args, recent: [] }) === 'browsing_produce') baseline++;
    if (chooseRoutineActivity({
      ...args, recent: [{ scene: 'supermarket', activity: 'something_else' }],
    }) === 'browsing_produce') repeated++;
  }
  assert.ok(repeated < baseline);
  const morning = { preference, at: local(28, 9), scene: 'bakery', recent: [], sequence: 3 };
  assert.equal(chooseRoutineActivity(morning), 'having_breakfast');
  assert.notEqual(chooseRoutineActivity({ ...morning, breakfastDay: calendarDay(morning.at) }), 'having_breakfast');
  assert.equal(chooseRoutineActivity({ ...morning, at: local(29, 9), breakfastDay: calendarDay(morning.at) }),
    'having_breakfast');
});
