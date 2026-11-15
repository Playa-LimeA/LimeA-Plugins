import { createHash } from 'node:crypto';
export const migrations = [
  {
    id: '1000_initial',
    sql: `
CREATE TABLE papers(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,status TEXT NOT NULL,updated_at INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX papers_session ON papers(session_id,updated_at);
CREATE TABLE attempts(id TEXT PRIMARY KEY,paper_id TEXT NOT NULL REFERENCES papers(id),session_id TEXT NOT NULL,status TEXT NOT NULL,updated_at INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX attempts_session ON attempts(session_id,updated_at);
CREATE UNIQUE INDEX attempts_active_session ON attempts(session_id) WHERE status='answering';
CREATE TABLE operations(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,action TEXT NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL CHECK(json_valid(result)));
CREATE TABLE model_requests(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,target_id TEXT NOT NULL,operation_id TEXT NOT NULL,phase TEXT NOT NULL,status TEXT NOT NULL,started_at INTEGER NOT NULL,ended_at INTEGER,input TEXT NOT NULL,output TEXT,usage TEXT);
`,
  },
];
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
export const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
export function createRepository(db, now) {
  let queue = Promise.resolve();
  const statement = (kind, value) => ({
    sql:
      kind === 'paper'
        ? 'INSERT INTO papers(id,session_id,status,updated_at,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,data=excluded.data'
        : 'INSERT INTO attempts(id,paper_id,session_id,status,updated_at,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,data=excluded.data',
    params:
      kind === 'paper'
        ? [value.id, value.sessionId, value.status, now(), JSON.stringify(value)]
        : [value.id, value.paperId, value.sessionId, value.status, now(), JSON.stringify(value)],
  });
  return {
    db,
    statement,
    serial(fn) {
      const next = queue.then(fn);
      queue = next.catch(() => {});
      return next;
    },
    async get(kind, id) {
      const row = await db.get(
        `SELECT data FROM ${kind === 'paper' ? 'papers' : 'attempts'} WHERE id=?`,
        [id],
      );
      return row ? JSON.parse(row.data) : null;
    },
    async list(kind, sessionId) {
      return (
        await db.all(
          `SELECT data FROM ${kind === 'paper' ? 'papers' : 'attempts'} WHERE session_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 50`,
          [sessionId],
        )
      ).map((r) => JSON.parse(r.data));
    },
    async save(kind, value, extra = []) {
      await db.transaction([statement(kind, value), ...extra]);
    },
    async receipt(key, sessionId, action, payload) {
      const row = await db.get('SELECT * FROM operations WHERE id=?', [key]);
      if (!row) return null;
      if (row.session_id !== sessionId || row.action !== action || row.digest !== digest(payload))
        throw new Error('operation-conflict');
      return JSON.parse(row.result);
    },
    receiptStatement(key, sessionId, action, payload, result) {
      return {
        sql: 'INSERT INTO operations(id,session_id,action,digest,result) VALUES(?,?,?,?,?)',
        params: [key, sessionId, action, digest(payload), JSON.stringify(result)],
      };
    },
    async lookup(key, sessionId) {
      const row = await db.get('SELECT result FROM operations WHERE id=? AND session_id=?', [
        key,
        sessionId,
      ]);
      return row ? JSON.parse(row.result) : null;
    },
  };
}
