import { fillScoreSchema, sameOptions } from './schemas.mjs';

// Compatibility normalization would erase meaningful superscripts/subscripts.
export const normalizeFill = (text) => text.normalize('NFC').trim();
export function fillParts(question, answer = []) {
  return question.blanks.map((blank, index) => {
    const value = answer[index] ?? '';
    const normalized = normalizeFill(value);
    return {
      id: blank.id,
      points: blank.points,
      answer: value,
      verdict: !normalized
        ? 'incorrect'
        : blank.answers.some((v) => normalizeFill(v) === normalized)
          ? 'correct'
          : null,
      explanation: !normalized ? '未作答。' : '与允许答案一致。',
    };
  });
}
function resultFor(parts, points) {
  const uncertain = parts.some((p) => p.verdict === 'uncertain');
  const score = parts.reduce((n, p) => n + (p.verdict === 'correct' ? p.points : 0), 0);
  return {
    verdict: uncertain
      ? 'uncertain'
      : score === points
        ? 'correct'
        : score
          ? 'partial'
          : 'incorrect',
    score: uncertain ? null : score,
    explanation: parts
      .map(
        (p, i) =>
          `第${i + 1}空：${p.verdict === 'uncertain' ? '待复核' : `${p.verdict === 'correct' ? p.points : 0}/${p.points}分`}，${p.explanation}`,
      )
      .join('\n'),
  };
}
export async function gradeFill(repo, task, step, slot, question, answer) {
  const parts = fillParts(question, answer);
  const pending = parts.filter((p) => p.verdict === null).map(({ id, answer }) => ({ id, answer }));
  if (pending.length) {
    await step('grade-fill', { slot, question, pending }, fillScoreSchema, (attempt, value) => {
      if (
        !sameOptions(
          value.blanks.map((b) => b.id),
          pending.map((b) => b.id),
        )
      )
        throw new Error('invalid-score');
      for (const item of value.blanks)
        Object.assign(
          parts.find((b) => b.id === item.id),
          item,
        );
      attempt.grades[slot.id] = resultFor(parts, slot.points);
    });
  } else {
    await repo.serial(async () => {
      task.signal.throwIfAborted();
      const attempt = await repo.get('attempt', task.id);
      if (attempt.operationId !== task.token) throw new Error('interrupted');
      attempt.grades[slot.id] = resultFor(parts, slot.points);
      await repo.save('attempt', attempt);
    });
  }
}
