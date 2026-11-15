import { DatabaseSync } from 'node:sqlite';
import { createExam, migrations } from '../src/exam.mjs';
export const spec = {
  title: '代数阶段测试',
  learningContext: '用户已经学习正负数、基础方程与等式性质，已完成简单计算练习，需要检查解题过程。',
  questionCount: 3,
  durationMinutes: 5,
  difficulty: '适中',
};
export const scope = { sessionId: 'learning-1', mode: 'learn' };
export function parsePrompt(input) {
  return {
    phase: input.prompt.split('\n')[0].slice(3),
    data: JSON.parse(input.prompt.split('任务数据:\n')[1]),
  };
}
export function responseFor(phase, data) {
  if (phase === 'blueprint')
    return {
      slots: Array.from({ length: data.questionCount }, (_, i) => ({
        id: `q${i + 1}`,
        type: ['single', 'multiple', 'short'][i % 3],
        topic: `代数考点${i + 1}`,
        points: Math.floor(100 / data.questionCount) + (i < 100 % data.questionCount ? 1 : 0),
        minutes: 1,
      })),
    };
  if (phase === 'question')
    return {
      id: data.slot.id,
      stem:
        data.slot.type === 'short'
          ? '请说明等式两边同时加上相同的数为什么仍然相等。'
          : `求解 $x+1=3$。这是第${data.slot.id.slice(1)}题。`,
      options:
        data.slot.type === 'short'
          ? []
          : [
              { id: 'A', text: '$x=2$' },
              { id: 'B', text: '$x=3$' },
              { id: 'C', text: '$x=1+1$' },
            ],
      correctOptions:
        data.slot.type === 'short' ? [] : data.slot.type === 'single' ? ['A'] : ['A', 'C'],
      referenceAnswer: `PRIVATE-ANSWER-${data.slot.id}：等式性质。`,
      rubric: '按正确的等式性质和完整解释评分。',
      explanation: '等量增加相同的量后仍然相等。',
      basis: '本次学习范围：基础代数。',
    };
  if (phase === 'solve')
    return {
      answer: '等量加等量，结果仍然相等。',
      selectedOptions: data.type === 'short' ? [] : data.type === 'single' ? ['A'] : ['A', 'C'],
      verdict: 'clear',
      reason: '条件充分，结论确定。',
    };
  if (phase === 'audit') return { verdict: 'pass', reason: '独立解答一致，评分标准明确。' };
  if (phase === 'whole')
    return { verdict: 'pass', questionIds: [], reason: '范围、分值、用时符合计划。' };
  if (phase === 'grade')
    return { verdict: 'correct', score: data.slot.points, explanation: '准确解释了等式性质。' };
  throw new Error(`unknown phase ${phase}`);
}
export function sqliteAdapter(sql) {
  return {
    get: async (q, p = []) => sql.prepare(q).get(...p) ?? null,
    all: async (q, p = []) => sql.prepare(q).all(...p),
    run: async (q, p = []) => sql.prepare(q).run(...p),
    transaction: async (entries) => {
      sql.exec('BEGIN');
      try {
        const results = entries.map(({ sql: q, params = [], result = 'run' }) =>
          sql.prepare(q)[result](...params),
        );
        sql.exec('COMMIT');
        return results;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
export async function fixture(t, override) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(migrations[0].sql);
  const db = sqliteAdapter(sql),
    calls = [];
  let now = 1000000,
    n = 0;
  let service = await createExam(db, { now: () => now, sweepInterval: 0 });
  const privateModel = {
    async request(input, signal) {
      const item = parsePrompt(input);
      calls.push(item);
      return {
        value: override ? await override(item, signal, calls) : responseFor(item.phase, item.data),
        usage: [{ inputTokens: 10, outputTokens: 20 }],
      };
    },
  };
  t.after(async () => {
    await service.dispose();
    sql.close();
  });
  const f = {
    sql,
    db,
    calls,
    get service() {
      return service;
    },
    get now() {
      return now;
    },
    set now(value) {
      now = value;
    },
    context(extra = {}) {
      return {
        ...scope,
        runId: `run-${++n}`,
        executionId: `exec-${n}`,
        signal: new AbortController().signal,
        privateModel,
        ...extra,
      };
    },
    action(action, extra = {}) {
      return service.action({ ...scope, action, requestId: `cmd-${++n}`, ...extra });
    },
    load(extra = {}) {
      return service.load({ ...scope, ...extra });
    },
    async prepare() {
      await service.prepare({ action: 'create', spec }, f.context());
      return f.load();
    },
    async start() {
      const state = await f.prepare();
      return f.action('start', { paperId: state.paper.id });
    },
    async reopen() {
      await service.dispose();
      service = await createExam(db, { now: () => now, sweepInterval: 0 });
    },
  };
  return f;
}
export const answers = {
  q1: ['A'],
  q2: ['A', 'C'],
  q3: '等量增加同样的量，差值仍为零，所以仍然相等。',
};
export async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition timed out');
}
