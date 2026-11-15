import {
  blueprintSchema,
  questionSchema,
  wholeAuditSchema,
  validateBlueprint,
  validateQuestion,
  validateAudit,
} from './schemas.mjs';
import { reviewData } from './review-document.mjs';

const blockingIds = (issues) => [
  ...new Set(issues.filter((i) => i.severity === 'blocking').flatMap((i) => i.questionIds)),
];

async function change(repo, task, apply) {
  return repo.serial(async () => {
    task.signal.throwIfAborted();
    const p = await repo.get('paper', task.id);
    if (p.operationId !== task.token) throw new Error('interrupted');
    apply(p);
    await repo.save('paper', p);
  });
}

export async function generate(repo, task, step) {
  await change(repo, task, (p) => {
    if (!p.generation) {
      // Upgrade unfinished papers only on explicit continuation; ready papers never enter here.
      for (const slot of p.blueprint?.slots ?? []) {
        const q = p.questions[slot.id] ?? p.candidates?.[slot.id];
        if (!q) continue;
        try {
          p.questions[slot.id] = validateQuestion(q, slot);
        } catch {
          delete p.questions[slot.id];
        }
      }
      p.candidates = {};
      p.solutions = {};
      p.rework = [];
      p.audit = null;
      p.generation = {
        version: 2,
        stage: 'draft',
        pending: [],
        changedIds: [],
        issues: [],
        invalidCounts: {},
      };
    }
    const g = p.generation;
    if (g.stage === 'blocked') {
      g.stage = 'repair';
      g.pending = blockingIds(g.issues);
      g.changedIds = [...g.pending];
      g.invalidCounts = {};
    }
    if (g.formatBlocked) {
      delete g.invalidCounts[g.formatBlocked];
      delete g.formatBlocked;
    }
  });
  let paper = await repo.get('paper', task.id);
  if (!paper.blueprint)
    await step('blueprint', paper.spec, blueprintSchema, (p, value) => {
      p.blueprint = validateBlueprint(value, p.spec);
    });

  for (;;) {
    task.signal.throwIfAborted();
    paper = await repo.get('paper', task.id);
    const stage = paper.generation.stage;
    if (stage === 'draft' || stage === 'repair') {
      const repair = stage === 'repair';
      for (const slot of paper.blueprint.slots) {
        paper = await repo.get('paper', task.id);
        if (repair ? !paper.generation.pending.includes(slot.id) : paper.questions[slot.id])
          continue;
        for (;;) {
          paper = await repo.get('paper', task.id);
          if ((paper.generation.invalidCounts[slot.id] ?? 0) >= 2) {
            await change(repo, task, (p) => {
              p.generation.formatBlocked = slot.id;
            });
            throw new Error('question-format-failed');
          }
          try {
            await step(
              repair ? 'repair' : 'question',
              {
                spec: paper.spec,
                blueprint: paper.blueprint,
                slot,
                existing: paper.blueprint.slots
                  .filter((s) => s.id !== slot.id && paper.questions[s.id])
                  .map((s) => ({
                    id: s.id,
                    topic: s.topic,
                    stem: paper.questions[s.id].stem.slice(0, 200),
                  })),
                feedback: paper.feedback[slot.id] ?? null,
                ...(repair
                  ? {
                      original: paper.questions[slot.id],
                      issues: paper.generation.issues.filter(
                        (i) => i.severity === 'blocking' && i.questionIds.includes(slot.id),
                      ),
                    }
                  : {}),
              },
              questionSchema,
              (p, value) => {
                p.questions[slot.id] = validateQuestion(value, slot);
                delete p.feedback[slot.id];
                if (repair)
                  p.generation.pending = p.generation.pending.filter((id) => id !== slot.id);
              },
            );
            break;
          } catch (error) {
            if (
              task.signal.aborted ||
              !['invalid-question', 'question-too-long', 'invalid-model-result'].includes(
                error.message,
              )
            )
              throw error;
            await change(repo, task, (p) => {
              p.generation.invalidCounts[slot.id] = (p.generation.invalidCounts[slot.id] ?? 0) + 1;
              p.feedback[slot.id] =
                '结构不符合约束：检查题号、题型、选项与正确答案数量、填空标记/分值，并将完整内容压缩至2200字符内。';
            });
          }
        }
      }
      await change(repo, task, (p) => {
        p.generation.stage = repair ? 'verify' : 'review';
      });
      continue;
    }
    if (!['review', 'verify'].includes(stage)) throw new Error('invalid-generation-state');
    const passed = await step(
      stage === 'verify' ? 'verify' : 'whole',
      reviewData(paper, stage === 'verify'),
      wholeAuditSchema,
      (p, value) => {
        const audit = validateAudit(value, p.blueprint.slots);
        p.audit = audit;
        p.generation.issues = audit.issues;
        const ids = blockingIds(audit.issues);
        if (!ids.length) {
          p.status = 'ready';
          p.readyAt = Date.now();
          p.operationId = null;
          p.error = null;
          p.phase = 'ready';
        } else if (stage === 'review') {
          p.generation.stage = 'repair';
          p.generation.pending = ids;
          p.generation.changedIds = ids;
          p.generation.invalidCounts = {};
        } else p.generation.stage = 'blocked';
        return !ids.length;
      },
    );
    if (passed) return;
    if (stage === 'verify') throw new Error('paper-review-failed');
  }
}
