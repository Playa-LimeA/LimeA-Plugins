import { activityCatalog } from './town-state.mjs';

export const departureDelay = 6000;

function hash(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index++) {
    value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  }
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  return (value ^ Math.imul(value, 0x846ca68b) ^ (value >>> 16)) >>> 0;
}

export function makePreferences(characterId) {
  const seed = hash(characterId);
  return {
    seed,
    wake: 360 + (hash(`${seed}:wake`) % 91),
    bed: 1260 + (hash(`${seed}:bed`) % 91),
    outing: 0.35 + (hash(`${seed}:outing`) % 51) / 100,
  };
}

export function calendarDay(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function localMinute(date, minute, offset = 0) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset, 0, minute).getTime();
}

export function nextWake(at, preference) {
  const date = new Date(at);
  const wake = preference?.wake ?? 360;
  const today = localMinute(date, wake);
  return today > at ? today : localMinute(date, wake, 1);
}

export function homeSchedule(at, preference) {
  const date = new Date(at);
  const minute = date.getHours() * 60 + date.getMinutes();
  const wake = preference?.wake ?? 360;
  const bed = preference?.bed ?? 1260;
  if (minute < wake || minute >= bed) {
    return { sleeping: true, endsAt: nextWake(at, preference) };
  }
  return {
    sleeping: false,
    endsAt: localMinute(date, minute < 660 ? 660 : minute < 1080 ? 1080 : bed),
  };
}

function roll(preference, at, sequence, purpose) {
  return hash(`${preference.seed}:${calendarDay(at)}:${sequence}:${purpose}`) / 2 ** 32;
}

export function chooseRoutineActivity({ preference, at, scene, recent, sequence, breakfastDay }) {
  const period = homeSchedule(at, preference);
  if (period.sleeping) return 'sleeping';
  const hour = new Date(at).getHours();
  const morning = hour < 11;
  const evening = hour >= 18;
  const hadBreakfast = breakfastDay === calendarDay(at);
  const homeAfternoon = !morning && !evening &&
    roll(preference, at, 0, 'home afternoon') < 1 - preference.outing * 0.8;
  const atHome = scene === 'home';
  const outside = recent.filter((item) => item.scene !== 'home').length;
  const canGoOut = atHome || (outside < 2 && scene !== 'bakery');
  const outdoors = morning
    ? ['browsing_bread', 'watching_water']
    : evening
      ? ['browsing_produce', 'browsing_bread', ...(hour < 20 ? ['watching_water'] : [])]
      : ['watching_water', 'browsing_cafe', 'browsing_produce', 'browsing_furniture', 'browsing_bread'];
  const indoors = morning
    ? ['watching_street', 'resting_sofa', ...(!hadBreakfast ? ['having_breakfast'] : [])]
    : evening
      ? ['resting_sofa', 'watching_tv', 'watching_street']
      : ['resting_sofa', 'watching_tv', 'watching_street', 'using_computer'];

  if (morning && scene === 'bakery' && !hadBreakfast) return 'having_breakfast';
  const chooseOutdoors = canGoOut && !homeAfternoon &&
    roll(preference, at, sequence, 'outside') < preference.outing * (atHome ? 1 : 0.45);
  const candidates = (chooseOutdoors ? outdoors : indoors).filter((activity) => Object.hasOwn(activityCatalog, activity));
  const weights = candidates.map((activity) => {
    const favor = 1 + (hash(`${preference.seed}:${activity}`) % 8) / 4;
    const publicStop = activity === 'watching_water' ? 1.35 : 1;
    const repeat = recent.findIndex((item) => item.activity === activity);
    const samePlace = recent.slice(0, 2).findIndex((item) => item.scene === activityCatalog[activity].scene);
    return publicStop * favor * (repeat < 0 ? 1 : 0.25 + repeat * 0.15) *
      (samePlace < 0 ? 1 : 0.5 + samePlace * 0.1);
  });
  let choice = roll(preference, at, sequence, 'activity') * weights.reduce((sum, value) => sum + value, 0);
  for (const [index, weight] of weights.entries()) {
    if (choice < weight) return candidates[index];
    choice -= weight;
  }
  return candidates.at(-1);
}

const streetStops = ['cafe_promenade_west', 'east_sidewalk_junction'];

export function chooseStreetStop({ preference, at, recent, sequence }) {
  const hour = new Date(at).getHours();
  if (
    hour < 8 ||
    hour >= 20 ||
    recent.slice(0, 2).some(({ scene }) => scene === 'street_corner') ||
    roll(preference, at, sequence, 'street stop') >= 0.22
  ) return undefined;
  const index = Math.floor(roll(preference, at, sequence, 'street point') * streetStops.length);
  return streetStops[index];
}

const dwellMinutes = {
  having_breakfast: [4, 8],
  watching_street: [3, 7],
  watching_tv: [7, 18],
  resting_sofa: [7, 18],
  using_computer: [12, 25],
  idle: [2, 6],
};

export function activityDwell(preference, at, sequence, activity) {
  if (activity === 'sleeping') return nextWake(at, preference) - at;
  const [min, max] = dwellMinutes[activity] ?? [5, 15];
  const fraction = roll(preference, at, sequence, 'dwell');
  return Math.floor((min + fraction * (max - min)) * 60000);
}
