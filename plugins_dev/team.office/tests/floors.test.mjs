import assert from 'node:assert/strict';
import test from 'node:test';

import { getFloors } from '../plugin/floors.mjs';

test('keeps the executive floor identity when ordinary floors are added or removed', () => {
  const assistant = { seatIndex: null, isAssistant: true };
  const throughFirstFloor = [{ seatIndex: 11 }, assistant];
  const expanded = getFloors([...throughFirstFloor, { seatIndex: 12 }], 12);
  assert.deepEqual(expanded.map(({ id }) => id), ['lobby', 'office:0', 'office:1', 'executive']);
  assert.equal(expanded.at(-1).code, '04F');
  assert.deepEqual(expanded.at(-1).members, [assistant]);

  const reduced = getFloors(throughFirstFloor, 12);
  assert.equal(reduced.at(-1).id, expanded.at(-1).id);
  assert.equal(reduced.at(-1).code, '03F');
  assert.deepEqual(reduced[0].members, []);
});

test('maps ordinary members by their assigned seat and preserves an empty standard floor', () => {
  const first = { seatIndex: 0 };
  const last = { seatIndex: 11 };
  const next = { seatIndex: 25 };
  const floors = getFloors([last, next, { seatIndex: null }, first], 12);
  assert.deepEqual(floors.map(({ members }) => members), [[], [first, last], [], [next], []]);
  assert.deepEqual(getFloors([], 12).map(({ code }) => code), ['01F', '02F', '03F']);
});
