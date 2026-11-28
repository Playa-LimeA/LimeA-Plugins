import { locations } from './locations.mjs';
import { navigation } from './navigation.mjs';
import { findWalk, getPortal, nextStop } from './routes.mjs';
import { activityDwell, calendarDay, chooseRoutineActivity, departureDelay, homeSchedule, makePreferences } from './routine.mjs';
import { activityCatalog, isTownState, walkingActivity } from './town-state.mjs';

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

function sameGoal(first, second) {
  return first?.scene === second.scene && first.point === second.point &&
    first.activity === second.activity;
}

export function makeTownJourney(
  initial,
  now,
  { preference = makePreferences('town'), checkpoint, restart = false } = {},
) {
  const saved = isTownState(initial) ? initial : null;
  const time = timestamp(now);
  let clock = checkpoint?.clock ?? time;
  let scene = checkpoint?.scene ?? saved?.scene ?? 'home';
  let point = checkpoint?.point ?? saved?.point ?? locations.home.visit;
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

  function selectGoal(at) {
    const activity = chooseRoutineActivity({ preference, at, scene, recent, sequence, breakfastDay });
    const { scene: destination, point: arrival } = activityCatalog[activity];
    return { scene: destination, point: arrival, activity, until: homeSchedule(at, preference).endsAt };
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
      const step = crosswalkExit
        ? { point: crosswalkExit }
        : scene === goal.scene
          ? { point: goal.point }
          : nextStop(locations, scene, goal.scene);
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
        const endsAt = at + activityDwell(preference, at, sequence, activity);
        nextAt = goal.manual ? endsAt : Math.min(endsAt, goal.until);
        stay = { activity, endsAt: nextAt };
        if (activity === 'having_breakfast') breakfastDay = calendarDay(at);
        recent = [{ scene, activity }, ...recent].slice(0, 4);
        sequence++;
        return;
      }
      point = getPortal(markers.get(scene), step.point, step.next);
      scene = step.next;
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
    const through = Math.min(now, clock + maxCatchUp);
    advanceThrough(through);
    const skipped = now - through;
    if (skipped && nextAt !== null) {
      // Carry an unfinished safe route forward from the confirmed point. An expired stay
      // or routine is reconsidered at the current local time without simulating missed hours.
      if (motion && (crosswalkExit || goal.manual || goal.until > now)) {
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
        version: 1, clock, scene, point, paused, remaining, nextAt, motion,
        crosswalkExit, goal, requested, stay, sequence, recent, breakfastDay,
      };
    },
  };
}
