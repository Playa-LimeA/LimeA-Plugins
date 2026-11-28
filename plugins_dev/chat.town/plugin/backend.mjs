import { randomUUID } from 'node:crypto';
import { locations } from './locations.mjs';
import { makePreferences } from './routine.mjs';
import { registerTownTools } from './town-tools.mjs';
import { isTownState } from './town-state.mjs';
import { makeTownJourney } from './journey.mjs';
import { changeTownClock, createTownClock, projectTownClock, realTownClock } from './town-clock.mjs';

const migrations = [
  {
    id: '1000_town_state',
    sql: `CREATE TABLE town_state (
      character_id TEXT PRIMARY KEY NOT NULL,
      scene TEXT NOT NULL,
      point TEXT NOT NULL,
      activity TEXT NOT NULL,
      destination TEXT,
      updated_at INTEGER NOT NULL
    ) STRICT;`,
  },
  {
    id: '1001_town_routine',
    sql: `ALTER TABLE town_state ADD COLUMN paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0, 1));
          ALTER TABLE town_state ADD COLUMN next_outing INTEGER NOT NULL DEFAULT 0 CHECK(next_outing >= 0);`,
  },
  {
    id: '1002_town_residents',
    sql: 'ALTER TABLE town_state ADD COLUMN resident_generation INTEGER;'
      + 'ALTER TABLE town_state ADD COLUMN preference_json TEXT;'
      + 'ALTER TABLE town_state ADD COLUMN journey_json TEXT;'
      + 'CREATE TABLE town_roster (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL, mutation_id TEXT) STRICT;'
      + 'INSERT INTO town_roster(singleton, revision) VALUES (1, 0);'
      + 'CREATE TABLE town_receipts (character_id TEXT NOT NULL, generation INTEGER NOT NULL, execution_id TEXT NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(character_id, generation, execution_id)) STRICT;',
  },
];

const clockMigrations = [
  {
    id: '1000_town_clock',
    sql: `CREATE TABLE town_clock (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      mode TEXT NOT NULL CHECK(mode IN ('real', 'virtual')),
      revision INTEGER NOT NULL CHECK(revision > 0),
      wall_anchor INTEGER NOT NULL CHECK(wall_anchor >= 0),
      town_anchor INTEGER NOT NULL CHECK(town_anchor >= 0)
    ) STRICT;`,
  },
];

function validCharacter(id) {
  return typeof id === 'string' && Boolean(id.trim()) && id.length <= 128 && id !== 'builtin:blank';
}

function checkCharacter(payload, ...fields) {
  if (!validCharacter(payload?.characterId) ||
      Object.keys(payload).some((key) => key !== 'characterId' && !fields.includes(key))) {
    throw new Error('invalid-town-character');
  }
  return payload.characterId;
}

function json(value) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function savedState(row) {
  const state = row && {
    scene: row.scene,
    point: row.point,
    activity: row.activity,
    ...(row.destination === null ? {} : { destination: row.destination }),
  };
  return isTownState(state) ? state : null;
}

function savedCheckpoint(row, state) {
  const stored = state ? json(row.journey_json) : null;
  return stored?.version === 1 && stored.scene === state.scene && stored.point === state.point
    ? stored
    : null;
}

function makeRole(characterId, generation, row, now, townClock, residenceStatus) {
  const state = savedState(row);
  const checkpoint = savedCheckpoint(row, state);
  const preference = json(row?.preference_json) ?? makePreferences(characterId);
  const journey = makeTownJourney(state, now, {
    preference, checkpoint, restart: true, townClock, residenceStatus,
  });
  const snapshot = journey.read(now);
  return { generation, preference, checkpoint: journey.checkpoint(), snapshot, updatedAt: now };
}

function roleStatement(characterId, role, mutationId = null) {
  const { scene, point, activity, destination, paused } = role.snapshot;
  return {
    sql: 'INSERT INTO town_state (character_id, scene, point, activity, destination, paused, next_outing, updated_at, resident_generation, preference_json, journey_json) '
      + 'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ? IS NULL OR EXISTS (SELECT 1 FROM town_roster WHERE mutation_id = ?) '
      + 'ON CONFLICT(character_id) DO UPDATE SET scene=excluded.scene, point=excluded.point, activity=excluded.activity, '
      + 'destination=excluded.destination, paused=excluded.paused, next_outing=excluded.next_outing, updated_at=excluded.updated_at, '
      + 'resident_generation=excluded.resident_generation, preference_json=excluded.preference_json, journey_json=excluded.journey_json',
    params: [
      characterId, scene, point, activity, destination ?? null, paused ? 1 : 0, 0,
      role.updatedAt, role.generation, JSON.stringify(role.preference), JSON.stringify(role.checkpoint),
      mutationId, mutationId,
    ],
  };
}

function projectState(role) {
  const { scene, point, activity, destination, destinationResidence, paused } = role.snapshot;
  return {
    scene, point, activity,
    ...(destination && !(destination === scene && destinationResidence) ? { destination } : {}),
    updatedAt: role.updatedAt,
    residentGeneration: role.generation,
    paused,
  };
}

function residenceIdentity(residence, names) {
  const resident = names.get(residence?.characterId);
  return resident && resident.generation === residence.generation
    ? { characterId: residence.characterId, name: resident.name }
    : undefined;
}

function projectView(role, names) {
  const { motion } = role.snapshot;
  return {
    ...projectState(role),
    ...(names ? projectResidences(role, names) : {}),
    ...(motion ? { motion } : {}),
  };
}

function projectResidences(role, names) {
  const residence = residenceIdentity(role.snapshot.residence, names);
  const destinationResidence = residenceIdentity(role.snapshot.destinationResidence, names);
  return {
    ...(residence ? { residence } : {}),
    ...(destinationResidence ? { destinationResidence } : {}),
  };
}

function projectChatState(role) {
  const { residence, destinationResidence } = role.snapshot;
  return {
    ...projectState(role),
    ...(residence ? { homeOwnerId: residence.characterId } : {}),
    ...(destinationResidence ? { destinationHomeOwnerId: destinationResidence.characterId } : {}),
  };
}

function toolState(role, names) {
  const { residentGeneration: _generation, ...state } = projectState(role);
  const housing = projectResidences(role, names);
  const host = housing.residence?.name;
  const visiting = host && state.activity === 'idle' && role.checkpoint.stay;
  const phase = state.paused ? 'paused'
    : state.activity === 'crossing' ? 'crossing'
      : state.activity === 'walking' ? 'traveling'
        : state.activity === 'idle' && !visiting ? 'staying' : 'doing';
  const next = role.checkpoint.requested ?? (!role.checkpoint.stay && role.checkpoint.goal);
  const nextResidence = next && residenceIdentity(next.residence, names);
  return {
    ...state,
    ...housing,
    location: host ? { zh: `${host}家`, en: `${host}’s home` } : locations[state.scene].name,
    ...(visiting ? { activityName: { zh: '正在做客', en: 'Visiting a resident' } } : {}),
    phase,
    ...(next ? { next: {
      scene: next.scene,
      ...(next.activity ? { activity: next.activity } : {}),
      ...(nextResidence ? { residence: nextResidence } : {}),
    } } : {}),
  };
}

function residenceStatusIn(roles, { characterId, generation }) {
  const host = roles.get(characterId);
  if (!host || host.generation !== generation) return 'not_resident';
  return host.snapshot.scene === 'home' && !host.snapshot.residence ? 'at_home' : 'away';
}

function sameResidence(a, b) {
  return a?.characterId === b?.characterId && a?.generation === b?.generation;
}

function hasEvictedResidence(role, roster) {
  const { residence, goal, requested } = role.checkpoint;
  return [residence, goal?.residence, requested?.residence]
    .some((reference) => reference && residenceStatusIn(roster, reference) === 'not_resident');
}

const nameCacheMs = 5000;

export async function apply(context) {
  const db = await context.storage.openDatabase({ name: 'town', migrations });
  const clockDb = await context.storage.openDatabase({ name: 'town-clock', migrations: clockMigrations });
  const savedClock = await clockDb.get(
    'SELECT mode, revision, wall_anchor AS wallAnchor, town_anchor AS townAnchor FROM town_clock WHERE singleton=1',
  );
  const directory = context.townCharacters;
  const roles = new Map();
  let townClock = savedClock ? createTownClock(savedClock) : realTownClock;
  let revision = (await db.get('SELECT revision FROM town_roster WHERE singleton=1')).revision;
  let pending = Promise.resolve();
  let disposed = false;
  let timer;
  let scheduledFor;
  let ticking = false;
  let unsubscribe;
  let nameCache;

  context.onDispose(() => {
    disposed = true;
    clearTimeout(timer);
    unsubscribe?.();
    roles.clear();
  });

  // A small town uses one queue for all membership changes and simulation commits.
  // A pending timer never keeps a separate, mutable reference to a role.
  function enqueue(task) {
    const result = pending.then(() => {
      if (disposed) throw new Error('town-closed');
      return task();
    });
    pending = result.catch(() => {});
    return result;
  }

  async function residents() {
    const ids = [...roles.keys()];
    return ids.length && directory ? directory.list(ids) : [];
  }

  async function residentNames() {
    if (nameCache?.expiresAt > Date.now()) return nameCache.names;
    const names = new Map(
      (await residents()).map(({ characterId, name }) => [
        characterId, { name, generation: roles.get(characterId).generation },
      ]),
    );
    nameCache = { names, expiresAt: Date.now() + nameCacheMs };
    return names;
  }

  async function roster() {
    return { revision, residents: await residents() };
  }

  async function loadResidents() {
    roles.clear();
    nameCache = undefined;
    if (!directory) return;
    const rows = await db.all('SELECT * FROM town_state WHERE resident_generation IS NOT NULL');
    const now = Date.now();
    // Restore against a complete saved roster, regardless of database row order.
    const savedRoster = new Map(rows.map((row) => {
      const state = savedState(row);
      const checkpoint = savedCheckpoint(row, state);
      return [row.character_id, {
        generation: row.resident_generation,
        snapshot: { scene: state?.scene ?? 'home', residence: checkpoint?.residence },
      }];
    }));
    for (const row of rows) {
      const role = makeRole(
        row.character_id, row.resident_generation, row, now, townClock,
        (reference) => residenceStatusIn(savedRoster, reference),
      );
      roles.set(row.character_id, role);
    }
    for (const [id, role] of roles) {
      if (!hasEvictedResidence(role, roles)) continue;
      roles.set(id, candidate(role, now).next);
    }
  }

  async function replaceRoster(expected, ids) {
    if (expected !== revision) return { conflict: true, ...(await roster()) };
    const present = new Set(ids);
    const added = ids.filter((id) => !roles.has(id));
    const removed = [...roles.keys()].filter((id) => !present.has(id));
    if (!added.length && !removed.length) return roster();

    const now = Date.now();
    const generation = revision + 1;
    const mutation = randomUUID();
    const incoming = added.map((id) => [id, makeRole(id, generation, null, now, townClock)]);
    const remaining = new Map([...roles].filter(([id]) => present.has(id)));
    for (const [id, role] of incoming) remaining.set(id, role);
    const reconciled = [];
    for (const [id, role] of remaining) {
      if (!hasEvictedResidence(role, remaining)) continue;
      const { next } = candidate(role, now, undefined, remaining);
      reconciled.push([id, next]);
    }
    const [compare] = await db.transaction([
      {
        sql: 'UPDATE town_roster SET revision=?, mutation_id=? WHERE singleton=1 AND revision=?',
        params: [generation, mutation, expected],
      },
      {
        sql: 'UPDATE town_state SET resident_generation=NULL, journey_json=NULL, destination=NULL WHERE '
          + 'resident_generation IS NOT NULL AND character_id IN (SELECT value FROM json_each(?)) '
          + 'AND EXISTS (SELECT 1 FROM town_roster WHERE mutation_id=?)',
        params: [JSON.stringify(removed), mutation],
      },
      ...incoming.map(([id, role]) => roleStatement(id, role, mutation)),
      ...reconciled.map(([id, role]) => roleStatement(id, role, mutation)),
    ]);

    if (!Number(compare.changes)) {
      revision = (await db.get('SELECT revision FROM town_roster WHERE singleton=1')).revision;
      await loadResidents();
      schedule();
      return { conflict: true, ...(await roster()) };
    }
    revision = generation;
    nameCache = undefined;
    for (const id of removed) roles.delete(id);
    for (const [id, role] of incoming) roles.set(id, role);
    for (const [id, role] of reconciled) roles.set(id, role);
    schedule();
    return roster();
  }

  function candidate(role, now, change, roster = roles) {
    const journey = makeTownJourney(null, now, {
      preference: role.preference,
      checkpoint: role.checkpoint,
      townClock,
      residenceStatus: (reference) => residenceStatusIn(roster, reference),
    });
    const decision = change ? change(journey, now) : null;
    const snapshot = decision?.snapshot ?? journey.read(now);
    return {
      next: {
        generation: role.generation,
        preference: role.preference,
        checkpoint: journey.checkpoint(),
        snapshot,
        updatedAt: now,
      },
      status: decision?.status,
    };
  }

  function due(role) {
    if (role.snapshot.nextAt === null) return Infinity;
    const next = (role.checkpoint.scheduleRevision ?? 0) === townClock.revision
      ? role.snapshot.nextAt : townClock.wallAnchor;
    return Math.max(next, role.retryAt ?? 0);
  }

  function schedule() {
    if (disposed || ticking) return;
    let next = Infinity;
    for (const role of roles.values()) next = Math.min(next, due(role));
    if (scheduledFor === next) return;
    clearTimeout(timer);
    scheduledFor = next;
    if (!Number.isFinite(next)) return;
    timer = setTimeout(() => {
      scheduledFor = undefined;
      ticking = true;
      void enqueue(async () => {
        const now = Date.now();
        for (const [characterId, role] of roles) {
          if (due(role) > now) continue;
          try {
            const { next } = candidate(role, now);
            const { sql, params } = roleStatement(characterId, next);
            await db.run(sql, params);
            if (!disposed) roles.set(characterId, next);
          } catch (error) {
            if (disposed) break;
            role.retryAt = now + 1000;
            console.warn('Companion Town background:', error);
          }
        }
      }).catch((error) => {
        if (!disposed) console.warn('Companion Town background:', error);
      }).finally(() => {
        ticking = false;
        schedule();
      });
    }, Math.max(0, next - Date.now()));
    timer.unref?.();
  }

  function actor(tool) {
    const role = validCharacter(tool?.characterId) && roles.get(tool.characterId);
    return role && role.generation === tool.residentGeneration ? role : null;
  }

  async function exists(id) {
    return validCharacter(id) && directory &&
      (await directory.list([id])).some(({ characterId }) => characterId === id);
  }

  async function action(tool, requested) {
    return enqueue(async () => {
      tool.signal?.throwIfAborted();
      const role = actor(tool);
      if (!role || !(await exists(tool.characterId))) return { status: 'not_resident' };
      if (typeof tool.executionId !== 'string' || !tool.executionId) return { status: 'invalid_execution' };
      const id = tool.characterId;
      const key = [id, role.generation, tool.executionId];
      const request = JSON.stringify(requested);
      const receipt = await db.get(
        'SELECT request, response FROM town_receipts WHERE character_id=? AND generation=? AND execution_id=?',
        key,
      );
      if (receipt) return receipt.request === request ? JSON.parse(receipt.response) : { status: 'conflict' };

      let goal = requested;
      let rejection;
      if (Object.hasOwn(requested, 'resident_id')) {
        const hostId = requested.resident_id;
        const host = roles.get(hostId);
        if (hostId === id) rejection = 'invalid_host';
        else if (!host || !(await exists(hostId))) rejection = 'host_not_resident';
        else {
          const residence = { characterId: hostId, generation: host.generation };
          goal = { scene: 'home', point: 'living_entry', residence };
          if (residenceStatusIn(roles, residence) !== 'at_home') rejection = 'host_away';
        }
      }

      let plan;
      if (!rejection) {
        try {
          plan = candidate(role, Date.now(), (journey, now) => journey.setAction(goal, now));
        } catch (error) {
          if (!String(error?.message).startsWith('No walking route') &&
              !String(error?.message).includes('is disconnected')) throw error;
        }
      }
      const names = await residentNames();
      const { residence, ...target } = goal;
      const host = residenceIdentity(residence, names);
      const response = {
        status: plan?.status ?? rejection ?? 'unreachable',
        current: toolState(plan?.next ?? role, names),
        target: host ? { ...target, residence: host } : target,
      };
      const writes = plan && plan.status !== 'paused' ? [roleStatement(id, plan.next)] : [];
      tool.signal?.throwIfAborted();
      await db.transaction([
        ...writes,
        {
          sql: 'INSERT INTO town_receipts (character_id, generation, execution_id, request, response) VALUES (?, ?, ?, ?, ?)',
          params: [...key, request, JSON.stringify(response)],
        },
      ]);
      if (writes.length && !disposed) roles.set(id, plan.next);
      schedule();
      return response;
    });
  }

  async function pruneDeleted() {
    const known = new Set((await residents()).map(({ characterId }) => characterId));
    if (known.size !== roles.size) await replaceRoster(revision, [...known]);
  }

  async function readWindow(characterId, selectedScene) {
    const role = roles.get(characterId);
    const scene = selectedScene ?? role?.snapshot.scene ?? 'home';
    const names = await residentNames();
    // Explicitly browsing Home means the selected character's own house. Following
    // a character in a house follows their physical instance, including a visit.
    const home = scene === 'home' && role
      ? (!selectedScene && role.snapshot.residence) || { characterId, generation: role.generation }
      : undefined;
    const residence = residenceIdentity(home, names);
    const occupants = [];
    for (const [occupantId, occupant] of roles) {
      const { scene: current, point, motion, residence: visited } = occupant.snapshot;
      if (current !== scene) continue;
      if (scene === 'home' && (!home || !sameResidence(
        home, visited ?? { characterId: occupantId, generation: occupant.generation },
      ))) continue;
      const name = names.get(occupantId)?.name;
      if (typeof name !== 'string') continue;
      occupants.push({ characterId: occupantId, name, point, ...(motion ? { motion } : {}) });
    }
    return {
      resident: role ? projectView(role, names) : null,
      scene,
      ...(residence ? { residence } : {}),
      occupants,
      clock: projectTownClock(townClock, Date.now()),
    };
  }

  if (directory) {
    unsubscribe = directory.onDeleted(() => enqueue(pruneDeleted));
    await enqueue(async () => {
      await loadResidents();
      await pruneDeleted();
      if (roles.size) await db.transaction([...roles].map(([id, role]) => roleStatement(id, role)));
    });
  }
  if (disposed) return;
  schedule();

  context.commands.register('read-town-clock', (payload) => {
    if (payload !== undefined) throw new Error('invalid-town-clock');
    return enqueue(() => projectTownClock(townClock, Date.now()));
  });
  context.commands.register('set-town-clock', (payload) => {
    if (
      !payload || typeof payload !== 'object' || Array.isArray(payload) ||
      (payload.mode !== 'real' && payload.mode !== 'virtual') ||
      Object.keys(payload).some((key) => key !== 'mode')
    ) throw new Error('invalid-town-clock');
    return enqueue(async () => {
      if (payload.mode !== townClock.mode) {
        const next = changeTownClock(townClock, payload.mode, Date.now());
        await clockDb.run(
          'INSERT INTO town_clock (singleton, mode, revision, wall_anchor, town_anchor) VALUES (1, ?, ?, ?, ?) '
            + 'ON CONFLICT(singleton) DO UPDATE SET mode=excluded.mode, revision=excluded.revision, '
            + 'wall_anchor=excluded.wall_anchor, town_anchor=excluded.town_anchor',
          [next.mode, next.revision, next.wallAnchor, next.townAnchor],
        );
        if (disposed) throw new Error('town-closed');
        townClock = next;
        schedule();
      }
      return projectTownClock(townClock, Date.now());
    });
  });
  context.commands.register('list-town-residents', (payload) => {
    if (payload !== undefined && (!payload || Object.keys(payload).length)) {
      throw new Error('invalid-town-roster');
    }
    return enqueue(roster);
  });
  context.commands.register('set-town-residents', (payload) => {
    if (!directory || !Number.isSafeInteger(payload?.revision) || payload.revision < 0 ||
        !Array.isArray(payload.characterIds) || !payload.characterIds.every(validCharacter) ||
        Object.keys(payload).some((key) => key !== 'revision' && key !== 'characterIds')) {
      throw new Error('invalid-town-roster');
    }
    const ids = [...new Set(payload.characterIds)];
    return enqueue(async () => {
      if (payload.revision !== revision) return { conflict: true, ...(await roster()) };
      const available = new Set((ids.length ? await directory.list(ids) : []).map(({ characterId }) => characterId));
      if (ids.some((id) => !available.has(id))) throw new Error('invalid-town-resident');
      return replaceRoster(payload.revision, ids);
    });
  });
  context.commands.register('read-town-state', (payload) => {
    const characterId = checkCharacter(payload);
    return enqueue(() => {
      const role = roles.get(characterId);
      return role ? projectState(role) : null;
    });
  });
  context.commands.register('read-town-chat-state', (payload) => {
    const characterId = checkCharacter(payload);
    return enqueue(() => {
      const role = roles.get(characterId);
      return role ? projectChatState(role) : null;
    });
  });
  context.commands.register('read-town-view', (payload) => {
    const characterId = checkCharacter(payload);
    return enqueue(() => {
      const role = roles.get(characterId);
      return role ? projectView(role) : null;
    });
  });
  context.commands.register('read-town-window', (payload) => {
    if (
      !payload || typeof payload !== 'object' || Array.isArray(payload) ||
      (payload.characterId !== null && !validCharacter(payload.characterId)) ||
      (payload.scene !== undefined && (typeof payload.scene !== 'string' || !Object.hasOwn(locations, payload.scene))) ||
      Object.keys(payload).some((key) => key !== 'characterId' && key !== 'scene')
    ) throw new Error('invalid-town-window');
    return enqueue(() => readWindow(payload.characterId, payload.scene));
  });
  context.commands.register('set-town-paused', (payload) => {
    const characterId = checkCharacter(payload, 'paused');
    if (typeof payload.paused !== 'boolean') throw new Error('invalid-town-pause');
    const generation = roles.get(characterId)?.generation;
    return enqueue(async () => {
      const role = roles.get(characterId);
      if (!role || role.generation !== generation) return null;
      const { next } = candidate(role, Date.now(), (journey, now) => ({
        snapshot: journey.setPaused(payload.paused, now),
      }));
      const { sql, params } = roleStatement(characterId, next);
      await db.run(sql, params);
      if (!disposed) roles.set(characterId, next);
      schedule();
      return projectView(next);
    });
  });
  registerTownTools(context.tools, {
    query: (tool, fn) => enqueue(async () => {
      tool.signal?.throwIfAborted();
      return actor(tool) && await exists(tool.characterId) ? fn() : { status: 'not_resident' };
    }),
    list: residents,
    residentState: async (id) => {
      const role = roles.get(id);
      return role && await exists(id) ? toolState(role, await residentNames()) : null;
    },
    action,
  });
}
