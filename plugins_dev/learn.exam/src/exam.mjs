import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createRepository, migrations } from './repository.mjs';
import { createModelTasks } from './model-tasks.mjs';
import { generate } from './generation.mjs';
import { gradeAttempt } from './grading.mjs';
import {
  id,
  scopeSchema,
  specSchema,
  prepareSchema,
  gradeInputSchema,
  reviewInputSchema,
  normalizeAnswers,
  publicResult,
} from './schemas.mjs';
export { migrations };

const actionSchema = scopeSchema
  .extend({
    action: z.enum(['start', 'save', 'submit', 'pause']),
    requestId: id,
    paperId: id.optional(),
    attemptId: id.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    answers: z
      .record(z.string(), z.union([z.string().max(4000), z.array(z.string()).max(6)]))
      .optional(),
    marked: z.array(id).max(20).optional(),
  })
  .strict();
const loadSchema = scopeSchema
  .extend({ paperId: id.optional(), attemptId: id.optional(), requestId: id.optional() })
  .strict();
function own(value, sessionId) {
  if (!value || value.sessionId !== sessionId) throw new Error('not-found');
  return value;
}
function summary(p) {
  return {
    id: p.id,
    title: p.spec.title,
    status: p.status,
    questionCount: p.spec.questionCount,
    durationMinutes: p.spec.durationMinutes,
    difficulty: p.spec.difficulty,
    approved: Object.keys(p.questions).length,
    phase: p.phase,
    error: p.error,
    createdAt: p.createdAt,
  };
}
function scoreSummary(a) {
  const grades = Object.values(a.grades);
  const uncertain = grades.filter((g) => g.score === null).length;
  const confirmedScore = grades.reduce((n, g) => n + (g.score ?? 0), 0);
  return {
    uncertain,
    confirmedScore,
    score: a.status === 'graded' && !uncertain ? confirmedScore : null,
  };
}

export async function createExam(db, { now = Date.now, sweepInterval = 1000 } = {}) {
  const repo = createRepository(db, now),
    tasks = createModelTasks(repo, now);
  let closed = false;
  await tasks.recover();
  async function expire(sessionId) {
    const rows = sessionId
      ? await db.all("SELECT data FROM attempts WHERE status='answering' AND session_id=?", [
          sessionId,
        ])
      : await db.all("SELECT data FROM attempts WHERE status='answering'");
    for (const row of rows) {
      const a = JSON.parse(row.data);
      if (a.deadline > now()) continue;
      a.status = 'submitted';
      a.submittedAt = a.deadline;
      a.submitReason = 'timeout';
      a.revision++;
      await repo.save('attempt', a);
    }
  }
  await expire();
  const timer =
    sweepInterval > 0
      ? setInterval(() => {
          if (!closed) void repo.serial(() => expire()).catch(() => {});
        }, sweepInterval)
      : null;
  timer?.unref?.();
  async function snapshot(input) {
    await expire(input.sessionId);
    const papers = await repo.list('paper', input.sessionId),
      attempts = await repo.list('attempt', input.sessionId);
    let attempt = input.attemptId
      ? own(await repo.get('attempt', input.attemptId), input.sessionId)
      : null;
    const paper = attempt
      ? own(await repo.get('paper', attempt.paperId), input.sessionId)
      : input.paperId
        ? own(await repo.get('paper', input.paperId), input.sessionId)
        : (papers[0] ?? null);
    if (!attempt && paper) attempt = attempts.find((a) => a.paperId === paper.id) ?? null;
    const view = {
      serverNow: now(),
      papers: papers.map(summary),
      attempts: attempts.map((a) => ({
        id: a.id,
        paperId: a.paperId,
        status: a.status,
        startedAt: a.startedAt,
        ...scoreSummary(a),
      })),
      paper: paper
        ? {
            ...summary(paper),
            learningContext: paper.spec.learningContext,
            topics: paper.blueprint?.slots.map((s) => s.topic) ?? [],
          }
        : null,
      attempt: null,
      receipt: input.requestId
        ? await repo.lookup(`command:${input.sessionId}:${input.requestId}`, input.sessionId)
        : null,
    };
    if (attempt && paper) {
      view.attempt = {
        id: attempt.id,
        paperId: paper.id,
        status: attempt.status,
        revision: attempt.revision,
        startedAt: attempt.startedAt,
        deadline: attempt.deadline,
        submittedAt: attempt.submittedAt,
        submitReason: attempt.submitReason,
        answers: attempt.answers,
        marked: attempt.marked,
        error: attempt.error,
        phase: attempt.phase,
        grades: attempt.grades,
        ...scoreSummary(attempt),
        questions: paper.blueprint.slots.map((slot) => {
          const q = paper.questions[slot.id];
          return {
            ...slot,
            stem: q.stem,
            options: q.options,
            ...(attempt.status !== 'answering'
              ? {
                  correctOptions: q.correctOptions,
                  referenceAnswer: q.referenceAnswer,
                  rubric: q.rubric,
                  explanation: q.explanation,
                }
              : {}),
          };
        }),
      };
    }
    return view;
  }
  async function load(raw) {
    if (closed) throw new Error('plugin-closed');
    const input = loadSchema.parse(raw);
    return repo.serial(() => snapshot(input));
  }
  async function action(raw) {
    if (closed) throw new Error('plugin-closed');
    const input = actionSchema.parse(raw),
      { sessionId } = input;
    return repo.serial(async () => {
      await expire(sessionId);
      const key = `command:${sessionId}:${input.requestId}`;
      let receipt = await repo.receipt(key, sessionId, input.action, input);
      if (!receipt) {
        let value, kind;
        if (input.action === 'start') {
          const paper = own(await repo.get('paper', input.paperId), sessionId);
          if (paper.status !== 'ready') throw new Error('paper-not-ready');
          const active = (await repo.list('attempt', sessionId)).find(
            (a) => a.status === 'answering',
          );
          if (active && active.paperId !== paper.id) throw new Error('exam-already-active');
          value = active ?? {
            id: randomUUID(),
            paperId: paper.id,
            sessionId,
            status: 'answering',
            revision: 0,
            answers: {},
            marked: [],
            grades: {},
            startedAt: now(),
            deadline: now() + paper.spec.durationMinutes * 60000,
            submittedAt: null,
            submitReason: null,
            error: null,
            phase: 'answering',
            operationId: null,
          };
          kind = 'attempt';
        } else if (input.action === 'pause') {
          value = own(await repo.get('paper', input.paperId), sessionId);
          kind = 'paper';
          if (value.status !== 'preparing') throw new Error('invalid-state');
          tasks.pause(value.id);
          value.status = 'paused';
          value.operationId = null;
          value.error = 'interrupted';
        } else {
          value = own(await repo.get('attempt', input.attemptId), sessionId);
          kind = 'attempt';
          if (input.action === 'save') {
            if (value.status !== 'answering') throw new Error('exam-closed');
            if (value.revision !== input.expectedRevision) throw new Error('revision-conflict');
            const paper = own(await repo.get('paper', value.paperId), sessionId);
            value.answers = normalizeAnswers(input.answers, paper);
            const marked = input.marked ?? [];
            if (new Set(marked).size !== marked.length || marked.some((k) => !paper.questions[k]))
              throw new Error('invalid-marked');
            value.marked = marked;
            value.revision++;
          } else if (value.status === 'answering') {
            if (value.revision !== input.expectedRevision) throw new Error('revision-conflict');
            value.status = 'submitted';
            value.submittedAt = now();
            value.submitReason = 'manual';
            value.revision++;
          }
        }
        // Reads above can cross the deadline. Discard the edited copy and seal the
        // last persisted answer set before attempting the final write.
        if (
          kind === 'attempt' &&
          ['save', 'submit'].includes(input.action) &&
          value.deadline <= now()
        ) {
          const persisted = await repo.get('attempt', value.id);
          if (persisted.status === 'answering') {
            persisted.status = 'submitted';
            persisted.submittedAt = persisted.deadline;
            persisted.submitReason = 'timeout';
            persisted.revision++;
            await repo.save('attempt', persisted);
          }
          if (input.action === 'save') throw new Error('exam-closed');
          value = persisted;
        }
        receipt = {
          action: input.action,
          paperId: kind === 'paper' ? value.id : value.paperId,
          ...(kind === 'attempt' ? { attemptId: value.id, revision: value.revision } : {}),
        };
        await repo.save(kind, value, [
          repo.receiptStatement(key, sessionId, input.action, input, receipt),
        ]);
      }
      return snapshot({
        sessionId,
        mode: 'learn',
        paperId: receipt.paperId,
        ...(receipt.attemptId ? { attemptId: receipt.attemptId } : {}),
        requestId: input.requestId,
      });
    });
  }
  async function prepare(raw, context) {
    scopeSchema.parse(context);
    const input = prepareSchema.parse(raw),
      key = `tool:${id.parse(context.executionId)}`;
    const { paperId, repeated } = await repo.serial(async () => {
      await expire(context.sessionId);
      const prior = await repo.receipt(key, context.sessionId, 'prepare', input);
      if (prior) return { ...prior, repeated: true };
      let paper;
      if (input.action === 'create') {
        const spec = specSchema.parse(input.spec);
        if ((await repo.list('attempt', context.sessionId)).some((a) => a.status === 'answering'))
          throw new Error('exam-already-active');
        if ((await repo.list('paper', context.sessionId)).some((p) => p.status === 'preparing'))
          throw new Error('task-busy');
        paper = {
          id: randomUUID(),
          sessionId: context.sessionId,
          spec,
          version: 1,
          status: 'paused',
          phase: 'blueprint',
          createdAt: now(),
          blueprint: null,
          questions: {},
          candidates: {},
          solutions: {},
          feedback: {},
          reviews: [],
          rework: [],
          audit: null,
          error: null,
          operationId: null,
        };
      } else paper = own(await repo.get('paper', input.paperId), context.sessionId);
      await repo.save('paper', paper, [
        repo.receiptStatement(key, context.sessionId, 'prepare', input, { paperId: paper.id }),
      ]);
      return { paperId: paper.id, repeated: false };
    });
    if (!repeated && (await repo.get('paper', paperId)).status !== 'ready')
      await tasks.run('paper', paperId, context, (task, step) => generate(repo, task, step));
    return publicResult(summary(await repo.get('paper', paperId)));
  }
  async function grade(raw, context) {
    scopeSchema.parse(context);
    const input = gradeInputSchema.parse(raw),
      key = `tool:${id.parse(context.executionId)}`;
    const repeated = await repo.serial(async () => {
      await expire(context.sessionId);
      const prior = await repo.receipt(key, context.sessionId, 'grade', input);
      if (prior) return true;
      const a = own(await repo.get('attempt', input.attemptId), context.sessionId);
      if (a.status === 'answering') throw new Error('exam-not-submitted');
      await repo.save('attempt', a, [
        repo.receiptStatement(key, context.sessionId, 'grade', input, { attemptId: a.id }),
      ]);
      return false;
    });
    if (!repeated && (await repo.get('attempt', input.attemptId)).status !== 'graded')
      await tasks.run('attempt', input.attemptId, context, (task, step) =>
        gradeAttempt(repo, task, step),
      );
    const a = await repo.get('attempt', input.attemptId);
    return publicResult({
      attemptId: a.id,
      status: a.status,
      graded: Object.keys(a.grades).length,
      error: a.error,
      ...scoreSummary(a),
    });
  }
  async function review(raw, context) {
    scopeSchema.parse(context);
    const input = reviewInputSchema.parse(raw);
    return repo.serial(async () => {
      await expire(context.sessionId);
      if (!input.attemptId)
        return publicResult({
          attempts: (await repo.list('attempt', context.sessionId))
            .filter((a) => a.status !== 'answering')
            .slice(0, 10)
            .map((a) => ({
              id: a.id,
              paperId: a.paperId,
              status: a.status,
              submittedAt: a.submittedAt,
              ...scoreSummary(a),
            })),
        });
      const a = own(await repo.get('attempt', input.attemptId), context.sessionId);
      if (a.status === 'answering') throw new Error('exam-not-submitted');
      const p = own(await repo.get('paper', a.paperId), context.sessionId);
      if (!input.questionId)
        return publicResult({
          attemptId: a.id,
          title: p.spec.title,
          status: a.status,
          ...scoreSummary(a),
          questions: p.blueprint.slots.map((s) => ({
            id: s.id,
            topic: s.topic,
            points: s.points,
            verdict: a.grades[s.id]?.verdict ?? 'pending',
            score: a.grades[s.id]?.score ?? null,
          })),
        });
      const slot = p.blueprint.slots.find((s) => s.id === input.questionId);
      if (!slot) throw new Error('not-found');
      return publicResult({
        attemptId: a.id,
        slot,
        question: p.questions[slot.id],
        answer: a.answers[slot.id] ?? null,
        grade: a.grades[slot.id] ?? null,
      });
    });
  }
  return {
    load,
    action,
    prepare,
    grade,
    review,
    finished: tasks.finished,
    async dispose() {
      closed = true;
      if (timer) clearInterval(timer);
      await tasks.dispose();
      await repo.serial(() => expire());
    },
  };
}
