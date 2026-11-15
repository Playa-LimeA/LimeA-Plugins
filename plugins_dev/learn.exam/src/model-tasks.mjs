import { randomUUID } from 'node:crypto';
import { jsonSchema } from './schemas.mjs';
import { prompt } from './prompts.mjs';

/** Only the short persistence sections are serialized. Model I/O never holds the queue. */
export function createModelTasks(repo, now) {
  const active = new Map();
  const pending = new Set();
  let closing = false;
  async function recover() {
    await repo.db.run(
      "UPDATE model_requests SET status='interrupted',ended_at=? WHERE status='running'",
      [now()],
    );
    for (const [table, kind, status] of [
      ['papers', 'paper', 'preparing'],
      ['attempts', 'attempt', 'grading'],
    ]) {
      for (const row of await repo.db.all(`SELECT data FROM ${table} WHERE status=?`, [status])) {
        const value = JSON.parse(row.data);
        value.status = kind === 'paper' ? 'paused' : 'submitted';
        value.error = 'interrupted';
        value.operationId = null;
        await repo.save(kind, value);
      }
    }
  }
  async function step(task, phase, data, schema, apply) {
    task.signal.throwIfAborted();
    const input = prompt(phase, data),
      requestId = randomUUID();
    await repo.serial(async () => {
      const value = await repo.get(task.kind, task.id);
      if (value.operationId !== task.token || closing) throw new Error('interrupted');
      task.signal.throwIfAborted();
      value.phase = phase;
      await repo.save(task.kind, value, [
        {
          sql: 'INSERT INTO model_requests(id,session_id,target_id,operation_id,phase,status,started_at,input) VALUES(?,?,?,?,?,?,?,?)',
          params: [requestId, value.sessionId, task.id, task.token, phase, 'running', now(), input],
        },
      ]);
    });
    try {
      const output = await task.context.privateModel.request(
        { inheritCharacter: false, prompt: input, outputSchema: jsonSchema(schema) },
        task.signal,
      );
      const parsed = schema.safeParse(output.value);
      if (!parsed.success) throw new Error('invalid-model-result');
      return await repo.serial(async () => {
        const value = await repo.get(task.kind, task.id);
        if (task.signal.aborted || value.operationId !== task.token || closing)
          throw new Error('interrupted');
        const result = apply(value, parsed.data);
        await repo.save(task.kind, value, [
          {
            sql: 'UPDATE model_requests SET status=?,ended_at=?,output=?,usage=? WHERE id=?',
            params: [
              'succeeded',
              now(),
              JSON.stringify(parsed.data),
              JSON.stringify(output.usage ?? null),
              requestId,
            ],
          },
        ]);
        return result;
      });
    } catch (error) {
      await repo.serial(() =>
        repo.db.run(
          "UPDATE model_requests SET status=?,ended_at=? WHERE id=? AND status='running'",
          [task.signal.aborted ? 'cancelled' : 'failed', now(), requestId],
        ),
      );
      throw error;
    }
  }
  async function runTask(kind, id, context, work) {
    if (closing) throw new Error('plugin-closed');
    if (!context.privateModel) throw new Error('host-update-required');
    const controller = new AbortController();
    const task = {
      kind,
      id,
      context,
      token: randomUUID(),
      controller,
      signal: AbortSignal.any([context.signal, controller.signal]),
    };
    await repo.serial(async () => {
      if (closing) throw new Error('plugin-closed');
      if (active.has(id)) throw new Error('task-busy');
      const value = await repo.get(kind, id);
      if (closing) throw new Error('plugin-closed');
      if (!value || value.sessionId !== context.sessionId) throw new Error('not-found');
      if (
        kind === 'paper'
          ? value.status === 'ready'
          : !['submitted', 'grading'].includes(value.status)
      )
        throw new Error('invalid-state');
      task.signal.throwIfAborted();
      value.status = kind === 'paper' ? 'preparing' : 'grading';
      value.operationId = task.token;
      value.error = null;
      await repo.save(kind, value);
      if (closing || task.signal.aborted) {
        value.status = kind === 'paper' ? 'paused' : 'submitted';
        value.operationId = null;
        value.error = 'interrupted';
        await repo.save(kind, value);
        throw new Error('interrupted');
      }
      active.set(id, task);
    });
    task.done = (async () => {
      try {
        await work(task, (phase, data, schema, apply) => step(task, phase, data, schema, apply));
      } catch (error) {
        await repo.serial(async () => {
          const value = await repo.get(kind, id);
          if (value.operationId !== task.token) return;
          value.status = kind === 'paper' ? 'paused' : 'submitted';
          value.error = task.signal.aborted ? 'interrupted' : publicError(error);
          value.operationId = null;
          await repo.save(kind, value);
        });
      } finally {
        active.delete(id);
      }
    })();
    await task.done;
  }
  return {
    recover,
    run(...args) {
      const completion = runTask(...args);
      pending.add(completion);
      completion.then(
        () => pending.delete(completion),
        () => pending.delete(completion),
      );
      return completion;
    },
    pause(id) {
      active.get(id)?.controller.abort();
    },
    finished(context) {
      for (const task of active.values())
        if (task.context.runId === context.runId) task.controller.abort();
    },
    async dispose() {
      closing = true;
      for (const task of active.values()) task.controller.abort();
      await Promise.allSettled([...pending]);
    },
  };
}
function publicError(error) {
  const known = [
    'invalid-blueprint',
    'invalid-question',
    'question-too-long',
    'prompt-too-long',
    'content-limit',
    'invalid-model-result',
    'question-review-failed',
    'paper-review-failed',
    'invalid-score',
  ];
  return known.includes(error?.message) ? error.message : 'model-request-failed';
}
