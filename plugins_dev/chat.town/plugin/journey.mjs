import { locations } from './locations.mjs';
import { navigation } from './navigation.mjs';
import { findWalk, getPortal, nextStop } from './routes.mjs';
import {
  activityDwell, calendarDay, chooseRoutineActivity, chooseStreetStop, departureDelay,
  homeSchedule, makePreferences,
} from './routine.mjs';
import { activityCatalog, isTownState, walkingActivity } from './town-state.mjs';
import { realTownClock } from './town-clock.mjs';

const walkingSpeed = 3.5;
const maxCatchUp = 5 * 60 * 1000;
const markers = new Map(
  Object.entries(navigation).map(([scene, points]) => [scene, new Map(Object.entries(points))]),
);

function timestamp(value) {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new TypeError('Invalid journey timestamp');
  }
  return Math.floor(value);
}

function distanceBetween(scene, from, to) {
  const a = markers.get(scene).get(from).position;
  const b = markers.get(scene).get(to).position;
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function exitOfCrossing(from, to) {
  while (true) {
    const neighbor = locations.street_corner.edges.find(([a, b]) =>
      ((a === to && b !== from) || (b === to && a !== from)) &&
      walkingActivity('street_corner', a, b) === 'crossing',
    );
    if (!neighbor) return to;
    const next = neighbor[0] === to ? neighbor[1] : neighbor[0];
    from = to;
    to = next;
  }
}

function sameResidence(first, second) {
  return first?.characterId === second?.characterId && first?.generation === second?.generation;
}

function sameGoal(first, second) {
  return first?.scene === second.scene && first.point === second.point &&
    first.activity === second.activity && sameResidence(first.residence, second.residence);
}

function returnHome() {
  return { scene: 'home', point: locations.home.visit, manual: true };
}

export function makeTownJourney(
  initial,
  now,
  {
    preference = makePreferences('town'),
    checkpoint,
    restart = false,
    residenceStatus = () => 'not_resident',
    townClock = realTownClock,
  } = {},
) {
  const saved = isTownState(initial) ? initial : null;
  const time = timestamp(now);
  let clock = checkpoint?.clock ?? time;
  let scene = checkpoint?.scene ?? saved?.scene ?? 'home';
  let point = checkpoint?.point ?? saved?.point ?? locations.home.visit;
  let residence = scene === 'home' ? checkpoint?.residence : undefined;
  let paused = checkpoint?.paused ?? (initial?.paused === true);
  let remaining = checkpoint?.remaining ?? departureDelay;
  let nextAt = checkpoint ? checkpoint.nextAt : paused ? null : clock + remaining;
  let motion = checkpoint?.motion && { ...checkpoint.motion };
  let crosswalkExit = checkpoint?.crosswalkExit;
  let goal = checkpoint?.goal;
  let requested = checkpoint?.requested;
  let stay = checkpoint?.stay;
  let sequence = checkpoint?.sequence ?? 0;
  let recent = checkpoint?.recent ?? [];
  let breakfastDay = checkpoint?.breakfastDay;

  if (checkpoint && (checkpoint.scheduleRevision ?? 0) !== townClock.revision) {
    rebaseSchedule();
  }

  if (checkpoint && restart) {
    clock = time;
    if (!paused && motion && (crosswalkExit || goal?.manual || goal?.until > time)) {
      nextAt = time + (motion.endsAt - motion.startsAt);
      motion = { ...motion, startsAt: time, endsAt: nextAt };
    } else if (!paused) {
      nextAt = motion ? time : Math.max(nextAt, time);
      motion = undefined;
    }
  }

  function scheduleAt(at) {
    const townAt = townClock.at(at);
    const period = homeSchedule(townAt, preference);
    return {
      townAt,
      sleeping: period.sleeping,
      until: at + townClock.wallDuration(period.endsAt - townAt),
    };
  }

  // The wall timeline still owns motion. Only routine deadlines and remaining stays
  // change when the durable town clock changes.
  function rebaseSchedule() {
    const at = Math.max(clock, townClock.wallAnchor);
    const schedule = scheduleAt(at);
    clock = at;
    if (goal && !goal.manual) {
      const wakingUp = goal.activity === 'sleeping' && !schedule.sleeping;
      goal = { ...goal, until: wakingUp ? at : schedule.until };
    }
    if (!stay) {
      if (nextAt !== null) nextAt = Math.max(nextAt, at);
      return;
    }

    const previousRate = checkpoint.scheduleRate === 10 ? 10 : 1;
    const previousRemaining = Math.max(0, paused ? remaining : stay.endsAt - at);
    const until = goal && !goal.manual ? goal.until : Infinity;
    const endsAt = stay.activity === 'sleeping' && goal && !goal.manual
      ? until
      : Math.min(at + townClock.wallDuration(previousRemaining * previousRate), until);
    stay = { ...stay, endsAt };
    if (paused) remaining = endsAt - at;
    else nextAt = endsAt;
  }

  function selectGoal(at) {
    const { townAt, until } = scheduleAt(at);
    const activity = chooseRoutineActivity({
      preference, at: townAt, scene, recent, sequence, breakfastDay,
    });
    const { scene: destination, point: arrival } = activityCatalog[activity];
    const streetStop = destination !== 'home' &&
      chooseStreetStop({ preference, at: townAt, recent, sequence });
    if (streetStop) return { scene: 'street_corner', point: streetStop, until };
    return { scene: destination, point: arrival, activity, until };
  }

  function startNext(at) {
    if (crosswalkExit === point) crosswalkExit = undefined;
    if (!crosswalkExit) {
      if (requested) {
        goal = requested;
        requested = undefined;
        stay = undefined;
      } else if (stay || (goal && !goal.manual && at >= goal.until)) {
        goal = undefined;
        stay = undefined;
      }
      goal ??= selectGoal(at);
    }

    while (true) {
      let step;
      if (crosswalkExit) {
        step = { point: crosswalkExit };
      } else if (scene === 'home' && goal.scene === 'home' && !sameResidence(residence, goal.residence)) {
        step = nextStop(locations, scene, 'street_corner');
      } else {
        step = scene === goal.scene ? { point: goal.point } : nextStop(locations, scene, goal.scene);
      }
      const [via] = findWalk(locations[scene].edges, point, step.point);
      if (via) {
        if (!crosswalkExit && walkingActivity(scene, point, via) === 'crossing') {
          crosswalkExit = exitOfCrossing(point, via);
        }
        const distance = distanceBetween(scene, point, via);
        if (distance < 0.001) {
          point = via;
          if (crosswalkExit === point) crosswalkExit = undefined;
          continue;
        }
        nextAt = at + Math.max(100, Math.round((distance * 1000) / walkingSpeed));
        motion = { from: point, to: via, startsAt: at, endsAt: nextAt };
        return;
      }
      if (!step.next) {
        const activity = goal.activity ?? 'idle';
        const townAt = townClock.at(at);
        const endsAt = at + townClock.wallDuration(activityDwell(preference, townAt, sequence, activity));
        nextAt = goal.manual ? endsAt : Math.min(endsAt, goal.until);
        stay = { activity, endsAt: nextAt };
        if (activity === 'having_breakfast') breakfastDay = calendarDay(townAt);
        recent = [{ scene, activity }, ...recent].slice(0, 4);
        sequence++;
        return;
      }
      if (step.next === 'home' && goal.residence && residenceStatus(goal.residence) !== 'at_home') {
        goal = returnHome();
        continue;
      }
      point = getPortal(markers.get(scene), step.point, step.next);
      scene = step.next;
      residence = scene === 'home' ? goal.residence : undefined;
    }
  }

  function reconcileResidences(at) {
    const retired = (home) => home && residenceStatus(home) === 'not_resident';
    const currentRetired = retired(residence);
    const goalRetired = retired(goal?.residence);
    const requestRetired = retired(requested?.residence);
    if (!currentRetired && !goalRetired && !requestRetired) return;

    if (requestRetired) requested = undefined;
    if (goalRetired) {
      goal = returnHome();
      stay = undefined;
    }
    if (currentRetired) {
      point = getPortal(markers.get('home'), 'exit_to_street', 'street_corner');
      scene = 'street_corner';
      residence = undefined;
      motion = undefined;
      stay = undefined;
      goal ??= returnHome();
    }
    if (!motion && (currentRetired || goalRetired)) {
      remaining = 0;
      if (!paused) nextAt = at;
    }
  }

  function advanceThrough(through) {
    while (nextAt !== null && nextAt <= through) {
      const at = nextAt;
      if (motion) {
        point = motion.to;
        motion = undefined;
      }
      startNext(at);
    }
  }

  function advance(value) {
    const now = Math.max(timestamp(value), clock);
    reconcileResidences(now);
    const through = Math.min(now, clock + maxCatchUp);
    advanceThrough(through);
    const skipped = now - through;
    if (skipped && nextAt !== null) {
      // Carry an unfinished safe route forward from the confirmed point. An expired stay
      // or routine is reconsidered at the current local time without simulating missed hours.
      if (motion && (crosswalkExit || goal?.manual || goal?.until > now)) {
        nextAt += skipped;
        motion.startsAt += skipped;
        motion.endsAt += skipped;
      } else if (nextAt <= now || (goal && !goal.manual && goal.until <= now)) {
        motion = undefined;
        nextAt = now;
        advanceThrough(now);
      }
    }
    clock = now;
    return now;
  }

  function snapshot() {
    return {
      scene,
      point,
      activity: motion ? walkingActivity(scene, point, motion.to) : stay?.activity ?? 'idle',
      ...(motion ? { destination: goal.scene, motion: { ...motion } } : {}),
      ...(residence ? { residence } : {}),
      ...(motion && goal.residence ? { destinationResidence: goal.residence } : {}),
      paused,
      nextAt,
    };
  }

  return {
    read(at) {
      advance(at);
      return snapshot();
    },
    setPaused(value, at) {
      if (typeof value !== 'boolean') throw new TypeError('Invalid journey pause flag');
      const now = advance(at);
      if (paused === value) return snapshot();
      paused = value;
      if (paused) {
        remaining = motion ? 0 : nextAt - now;
        motion = undefined;
        nextAt = null;
      } else {
        const deadline = stay?.activity === 'sleeping' ? stay.endsAt : goal?.until ?? Infinity;
        nextAt = Math.max(now, Math.min(now + remaining, deadline));
        advance(now);
      }
      return snapshot();
    },
    setAction(action, at) {
      const now = advance(at);
      if (paused) return { status: 'paused', snapshot: snapshot() };
      if (sameGoal(requested, action) || (!requested && goal?.manual && sameGoal(goal, action))) {
        return { status: stay && !requested ? 'started' : 'accepted', snapshot: snapshot() };
      }
      requested = { ...action, manual: true };
      if (!motion && !crosswalkExit) {
        nextAt = now;
        advance(now);
      }
      return { status: stay && !requested ? 'started' : 'accepted', snapshot: snapshot() };
    },
    checkpoint() {
      return {
        version: 1, clock, scene, point, residence, paused, remaining, nextAt, motion,
        crosswalkExit, goal, requested, stay, sequence, recent, breakfastDay,
        ...(townClock.revision ? { scheduleRevision: townClock.revision, scheduleRate: townClock.rate } : {}),
      };
    },
  };
}
