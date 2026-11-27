import {
  activities,
  areaAt,
  makeRoute,
  outboundActions,
  returningAction,
  seatArea,
} from './office-routes.mjs';

const deskActions = activities.filter((action) => action.type === 'desk');
const awayActions = activities.filter((action) => action.type !== 'desk');

export function createOfficeActivity(
  layout,
  onChange,
  {
    random = Math.random,
    now = () => performance.now(),
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (frame) => cancelAnimationFrame(frame),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (timer) => clearTimeout(timer),
    reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    timing = {},
  } = {},
) {
  const seats = new Map(layout.seats.map((seat) => [seat.id, seat]));
  const members = new Map();
  const initialDelay = timing.initialDelay ?? [2000, 8000];
  const activityDuration = timing.activityDuration ?? [12000, 25000];
  const visitDuration = timing.visitDuration ?? [5500, 12000];
  const speed = (timing.movementSpeed ?? 3.4) / 1000;
  let visible = false;
  let disposed = false;
  let offset = 0;
  let resumedAt = 0;
  let timer;
  let frame;

  const time = () => offset + (visible ? now() - resumedAt : 0);
  const delay = ([min, max]) => min + random() * (max - min);
  const choose = (items) => items[Math.floor(random() * items.length)];

  function cancelScheduled() {
    if (timer !== undefined) clearTimer(timer);
    if (frame !== undefined) cancelFrame(frame);
    timer = frame = undefined;
  }

  function desk(member, at, interval) {
    member.phase = 'desk';
    member.position = null;
    member.walk = null;
    member.outbound = null;
    member.action = null;
    member.due = Infinity;
    if (member.activity === 'idle') {
      member.action = choose(deskActions.filter((action) => action !== member.lastAction));
      member.lastAction = member.action;
      member.due = at + delay(interval);
    }
  }

  function walk(member, points, phase, at) {
    member.phase = phase;
    member.due = Infinity;
    if (reducedMotion) {
      if (phase === 'returning') desk(member, at, activityDuration);
      else {
        member.phase = 'visiting';
        member.position = points.at(-1);
        member.walk = null;
        member.due = at + delay(visitDuration);
      }
      return;
    }
    member.position = points[0];
    const movement =
      phase !== 'returning'
        ? speed
        : member.activity === 'idle' && member.action?.slowReturn
          ? speed * 0.75
          : speed * 1.2;
    member.walk = { points, index: 1, at, speed: movement };
  }

  function returnHome(member, at) {
    if (member.phase === 'returning') return;
    const reached = member.walk ? member.walk.index : member.outbound.length - 1;
    const points = [member.position, ...member.outbound.slice(0, reached).reverse()];
    walk(member, points, 'returning', at);
  }

  function startActivity(member, at) {
    const away = [...members.values()].filter((other) => other.phase !== 'desk');
    if (away.length >= seats.size || random() < 0.27) {
      desk(member, at, activityDuration);
      return;
    }
    const colleagues = [...members.values()].filter(
      (other) =>
        other !== member &&
        other.phase === 'desk' &&
        seatArea(other.seat.id) === seatArea(member.seat.id),
    );
    const neighbor = colleagues
      .map((other) => other.seat)
      .sort((a, b) => {
        const difference = (seat) =>
          Math.hypot(
            seat.avatar[0] - member.seat.avatar[0],
            seat.avatar[2] - member.seat.avatar[2],
          );
        return difference(a) - difference(b);
      })[0];
    const destinations = away.map(({ outbound }) => outbound.at(-1));
    const candidates = awayActions.flatMap((action) => {
      if (action === member.lastAction || (action.type === 'neighbor' && !neighbor)) return [];
      const points = makeRoute(member.seat, action, neighbor);
      const [x, , z] = points.at(-1);
      return destinations.some(([dx, , dz]) => Math.hypot(x - dx, z - dz) < 0.55)
        ? []
        : [{ action, points }];
    });
    if (!candidates.length) {
      desk(member, at, activityDuration);
      return;
    }
    const { action, points } = choose(candidates);
    member.action = member.lastAction = action;
    member.outbound = points;
    walk(member, points, 'outbound', at);
  }

  function advanceWalk(member, at) {
    const path = member.walk;
    while (path.index < path.points.length) {
      const from = path.points[path.index - 1];
      const to = path.points[path.index];
      const duration = Math.hypot(...to.map((value, axis) => value - from[axis])) / path.speed;
      const progress = duration ? (at - path.at) / duration : 1;
      if (progress < 1) {
        member.position = from.map((value, axis) => value + (to[axis] - value) * progress);
        return;
      }
      member.position = to;
      path.at += duration;
      path.index++;
    }
    if (member.phase === 'returning') desk(member, at, activityDuration);
    else {
      member.phase = 'visiting';
      member.walk = null;
      member.due = at + delay(visitDuration);
    }
  }

  function tick() {
    timer = frame = undefined;
    if (!visible || disposed) return;
    const at = time();
    for (const member of members.values()) {
      if (member.walk) advanceWalk(member, at);
      else if (member.due <= at) {
        if (member.phase === 'visiting') returnHome(member, at);
        else startActivity(member, at);
      }
    }
    onChange();
    schedule();
  }

  function schedule() {
    cancelScheduled();
    if (!visible || disposed) return;
    let due = Infinity;
    for (const member of members.values()) {
      if (member.walk) {
        frame = requestFrame(tick);
        return;
      }
      due = Math.min(due, member.due);
    }
    if (Number.isFinite(due)) timer = setTimer(tick, Math.max(0, due - time()));
  }

  return {
    setMembers(value) {
      if (disposed) return;
      const next = new Set();
      const at = time();
      let changed = false;
      for (const { id, seatId, activity } of value) {
        const seat = seats.get(seatId);
        if (!seat) continue;
        next.add(id);
        let member = members.get(id);
        if (!member || member.seat !== seat) {
          member = { seat, activity, lastAction: null };
          desk(member, at, initialDelay);
          members.set(id, member);
          changed = true;
        } else if (member.activity !== activity) {
          // Capture the current position before turning around on an interrupted trip.
          if (member.walk) advanceWalk(member, at);
          member.activity = activity;
          if (member.phase === 'desk') desk(member, at, initialDelay);
          else if (activity !== 'idle') returnHome(member, at);
          changed = true;
        }
      }
      for (const id of members.keys()) {
        if (next.has(id)) continue;
        members.delete(id);
        changed = true;
      }
      if (changed) {
        onChange();
        schedule();
      }
    },
    get(id) {
      const member = members.get(id);
      if (!member) return null;
      let action = null;
      if (member.activity === 'idle') {
        if (member.phase === 'outbound') action = outboundActions[member.action.type];
        else if (member.phase === 'returning')
          action = member.action?.slowReturn ? member.action.text : returningAction;
        else action = member.action.text;
      }
      return {
        position: member.position,
        area: member.position ? areaAt(member.position) : seatArea(member.seat.id),
        action,
      };
    },
    setVisible(value) {
      if (disposed || value === visible) return;
      offset = time();
      resumedAt = now();
      visible = value;
      schedule();
    },
    dispose() {
      disposed = true;
      cancelScheduled();
      members.clear();
    },
  };
}
