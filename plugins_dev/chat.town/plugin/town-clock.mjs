const virtualRate = 10;

export function createTownClock({ mode, revision, wallAnchor, townAnchor }) {
  if (
    (mode !== 'real' && mode !== 'virtual') ||
    ![revision, wallAnchor, townAnchor].every((value) => Number.isSafeInteger(value) && value >= 0)
  ) {
    throw new TypeError('Invalid town clock');
  }
  const rate = mode === 'virtual' ? virtualRate : 1;
  return {
    mode,
    revision,
    wallAnchor,
    townAnchor,
    rate,
    at(wall) {
      return mode === 'real' ? wall : Math.max(0, townAnchor + (wall - wallAnchor) * rate);
    },
    wallDuration(townDuration) {
      return Math.ceil(townDuration / rate);
    },
  };
}

export const realTownClock = createTownClock({
  mode: 'real', revision: 0, wallAnchor: 0, townAnchor: 0,
});

export function changeTownClock(clock, mode, wall) {
  if (mode === clock.mode) return clock;
  return createTownClock({
    mode,
    revision: clock.revision + 1,
    wallAnchor: wall,
    townAnchor: mode === 'virtual' ? clock.at(wall) : wall,
  });
}

export function projectTownClock(clock, wall) {
  return { mode: clock.mode, at: clock.at(wall) };
}
