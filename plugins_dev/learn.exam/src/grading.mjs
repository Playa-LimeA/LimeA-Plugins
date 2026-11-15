import { sameOptions, answered, scoreSchema } from './schemas.mjs';
import { gradeFill } from './fill-grading.mjs';
export async function gradeAttempt(repo, task, step) {
  let attempt = await repo.get('attempt', task.id);
  const paper = await repo.get('paper', attempt.paperId);
  for (const slot of paper.blueprint.slots) {
    task.signal.throwIfAborted();
    attempt = await repo.get('attempt', task.id);
    if (attempt.grades[slot.id]) continue;
    const answer = attempt.answers[slot.id],
      question = paper.questions[slot.id];
    if (slot.type === 'fill') {
      await gradeFill(repo, task, step, slot, question, answer);
    } else if (!answered(answer) || slot.type !== 'short') {
      const correct = answered(answer) && sameOptions(answer, question.correctOptions);
      await repo.serial(async () => {
        task.signal.throwIfAborted();
        const a = await repo.get('attempt', task.id);
        if (a.operationId !== task.token) throw new Error('interrupted');
        a.grades[slot.id] = {
          verdict: correct ? 'correct' : 'incorrect',
          score: correct ? slot.points : 0,
          explanation: !answered(answer)
            ? '本题未作答。'
            : correct
              ? '作答与参考答案一致。'
              : '作答与参考答案不符。多选题需全部选对才得分。',
        };
        await repo.save('attempt', a);
      });
    } else
      await step('grade', { slot, question, answer }, scoreSchema, (a, value) => {
        if (
          value.verdict === 'uncertain'
            ? value.score !== null
            : value.score === null ||
              value.score > slot.points ||
              (value.verdict === 'correct' && value.score !== slot.points) ||
              (value.verdict === 'incorrect' && value.score !== 0)
        )
          throw new Error('invalid-score');
        a.grades[slot.id] = value;
      });
  }
  await repo.serial(async () => {
    task.signal.throwIfAborted();
    const a = await repo.get('attempt', task.id);
    if (a.operationId !== task.token) throw new Error('interrupted');
    a.status = 'graded';
    a.operationId = null;
    a.error = null;
    a.phase = 'graded';
    await repo.save('attempt', a);
  });
}
