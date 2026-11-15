import {
  blueprintSchema,
  questionSchema,
  solutionSchema,
  auditSchema,
  wholeAuditSchema,
  validateBlueprint,
  validateQuestion,
  sameOptions,
} from './schemas.mjs';

export async function generate(repo, task, step) {
  let paper = await repo.get('paper', task.id);
  if (!paper.blueprint)
    await step('blueprint', paper.spec, blueprintSchema, (p, value) => {
      p.blueprint = validateBlueprint(value, p.spec);
    });
  let wholeReworks = 0;
  for (;;) {
    task.signal.throwIfAborted();
    paper = await repo.get('paper', task.id);
    // A failed whole-paper audit has a durable, explicit rework set.
    if (paper.rework?.length) {
      await repo.serial(async () => {
        const p = await repo.get('paper', task.id);
        for (const id of p.rework) {
          delete p.questions[id];
          delete p.candidates[id];
          delete p.solutions[id];
          p.feedback[id] = p.audit?.reason ?? '请重新审核并修改本题。';
        }
        p.rework = [];
        await repo.save('paper', p);
      });
    }
    paper = await repo.get('paper', task.id);
    for (const slot of paper.blueprint.slots) {
      paper = await repo.get('paper', task.id);
      if (paper.questions[slot.id]) continue;
      let approved = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        task.signal.throwIfAborted();
        paper = await repo.get('paper', task.id);
        if (!paper.candidates[slot.id]) {
          try {
            await step(
              'question',
              { spec: paper.spec, slot, feedback: paper.feedback[slot.id] ?? null },
              questionSchema,
              (p, value) => {
                p.candidates[slot.id] = validateQuestion(value, slot);
                delete p.solutions[slot.id];
              },
            );
          } catch (error) {
            if (
              !['invalid-question', 'question-too-long', 'invalid-model-result'].includes(
                error.message,
              )
            )
              throw error;
            await feedback(
              repo,
              task,
              slot.id,
              '题目结构无效或超过2200字符，请简化并满足字段约束。',
            );
            continue;
          }
        }
        paper = await repo.get('paper', task.id);
        const candidate = paper.candidates[slot.id];
        if (!paper.solutions[slot.id])
          await step(
            'solve',
            { type: slot.type, stem: candidate.stem, options: candidate.options },
            solutionSchema,
            (p, value) => {
              p.solutions[slot.id] = value;
            },
          );
        paper = await repo.get('paper', task.id);
        const solution = paper.solutions[slot.id];
        if (
          solution.verdict !== 'clear' ||
          (slot.type !== 'short' &&
            !sameOptions(solution.selectedOptions, candidate.correctOptions))
        ) {
          await feedback(
            repo,
            task,
            slot.id,
            `独立解题未通过：${solution.reason}；请修订题干、条件或答案。`,
          );
          continue;
        }
        const audit = await step(
          'audit',
          {
            learningContext: paper.spec.learningContext,
            slot,
            candidate,
            independentSolution: solution,
          },
          auditSchema,
          (p, value) => {
            p.reviews.push({ questionId: slot.id, ...value });
            p.reviews = p.reviews.slice(-100);
            if (value.verdict === 'pass') {
              p.questions[slot.id] = p.candidates[slot.id];
              delete p.candidates[slot.id];
              delete p.solutions[slot.id];
              delete p.feedback[slot.id];
            } else {
              p.feedback[slot.id] = value.reason;
              delete p.candidates[slot.id];
              delete p.solutions[slot.id];
            }
            return value;
          },
        );
        if (audit.verdict === 'pass') {
          approved = true;
          break;
        }
      }
      if (!approved) throw new Error('question-review-failed');
    }
    paper = await repo.get('paper', task.id);
    const audit = await step(
      'whole',
      { spec: paper.spec, blueprint: paper.blueprint, questions: paper.questions },
      wholeAuditSchema,
      (p, value) => {
        const ids = p.blueprint.slots.map((s) => s.id);
        if (
          value.questionIds.some((id) => !ids.includes(id)) ||
          (value.verdict === 'pass' && value.questionIds.length)
        )
          throw new Error('invalid-model-result');
        p.audit = value;
        if (value.verdict === 'pass') {
          p.status = 'ready';
          p.readyAt = Date.now();
          p.operationId = null;
          p.error = null;
          p.phase = 'ready';
        } else p.rework = value.questionIds.length ? [...new Set(value.questionIds)] : ids;
        return value;
      },
    );
    if (audit.verdict === 'pass') return;
    if (wholeReworks++ >= 1) throw new Error('paper-review-failed');
  }
}
async function feedback(repo, task, id, reason) {
  await repo.serial(async () => {
    task.signal.throwIfAborted();
    const p = await repo.get('paper', task.id);
    if (p.operationId !== task.token) throw new Error('interrupted');
    p.feedback[id] = reason;
    delete p.candidates[id];
    delete p.solutions[id];
    await repo.save('paper', p);
  });
}
