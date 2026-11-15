import { z } from 'zod';

export const id = z.string().min(1).max(128);
const text = (max) => z.string().trim().min(1).max(max);
export const scopeSchema = z.object({ sessionId: id, mode: z.literal('learn') });
export const specSchema = z
  .object({
    title: text(100),
    learningContext: text(6000).min(20),
    questionCount: z.number().int().min(3).max(20),
    durationMinutes: z.number().int().min(5).max(180),
    difficulty: z.enum(['基础', '适中', '进阶']),
  })
  .strict();
export const prepareSchema = z
  .object({
    action: z.enum(['create', 'resume']),
    paperId: id.optional(),
    spec: specSchema.optional(),
  })
  .strict();
export const gradeInputSchema = z.object({ attemptId: id }).strict();
export const reviewInputSchema = z
  .object({ attemptId: id.optional(), questionId: id.optional() })
  .strict();
export const slotSchema = z
  .object({
    id: text(12),
    type: z.enum(['single', 'multiple', 'short']),
    topic: text(100),
    points: z.number().int().min(1).max(100),
    minutes: z.number().min(0.5).max(180),
  })
  .strict();
export const blueprintSchema = z.object({ slots: z.array(slotSchema).min(3).max(20) }).strict();
export const questionSchema = z
  .object({
    id: text(12),
    stem: text(1000),
    options: z.array(z.object({ id: text(2), text: text(160) }).strict()).max(6),
    correctOptions: z.array(text(2)).max(6),
    referenceAnswer: text(600),
    rubric: text(600),
    explanation: text(600),
    basis: text(250),
  })
  .strict();
export const solutionSchema = z
  .object({
    answer: text(1000),
    selectedOptions: z.array(text(2)).max(6),
    verdict: z.enum(['clear', 'ambiguous', 'uncertain']),
    reason: text(600),
  })
  .strict();
export const auditSchema = z
  .object({
    verdict: z.enum(['pass', 'revise', 'uncertain']),
    reason: text(800),
  })
  .strict();
export const wholeAuditSchema = z
  .object({
    verdict: z.enum(['pass', 'revise', 'uncertain']),
    reason: text(800),
    questionIds: z.array(text(12)).max(20),
  })
  .strict();
export const scoreSchema = z
  .object({
    verdict: z.enum(['correct', 'partial', 'incorrect', 'uncertain']),
    score: z.number().min(0).max(100).nullable(),
    explanation: text(1200),
  })
  .strict();
export const jsonSchema = (schema) => z.toJSONSchema(schema);
export function bounded(value, limit, code = 'content-limit') {
  if (JSON.stringify(value).length > limit) throw new Error(code);
  return value;
}
export function publicResult(value) {
  if (Buffer.byteLength(JSON.stringify(value)) > 24000) throw new Error('public-result-limit');
  return value;
}
export function validateBlueprint(raw, spec) {
  const value = bounded(blueprintSchema.parse(raw), 6000);
  if (
    value.slots.length !== spec.questionCount ||
    value.slots.some((slot, i) => slot.id !== `q${i + 1}`) ||
    value.slots.reduce((n, s) => n + s.points, 0) !== 100 ||
    value.slots.reduce((n, s) => n + s.minutes, 0) > spec.durationMinutes
  )
    throw new Error('invalid-blueprint');
  return value;
}
export const sameOptions = (a, b) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
export function validateQuestion(raw, slot) {
  const value = bounded(questionSchema.parse(raw), 2200, 'question-too-long');
  const keys = value.options.map((o) => o.id);
  if (
    value.id !== slot.id ||
    new Set(keys).size !== keys.length ||
    new Set(value.options.map((o) => o.text)).size !== keys.length ||
    new Set(value.correctOptions).size !== value.correctOptions.length ||
    value.correctOptions.some((key) => !keys.includes(key))
  )
    throw new Error('invalid-question');
  if (
    slot.type === 'short'
      ? keys.length || value.correctOptions.length
      : keys.length < 2 ||
        !value.correctOptions.length ||
        (slot.type === 'single' && value.correctOptions.length !== 1)
  )
    throw new Error('invalid-question');
  return value;
}
export function normalizeAnswers(raw, paper) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid-answers');
  const result = {};
  for (const [key, answer] of Object.entries(raw)) {
    const slot = paper.blueprint.slots.find((s) => s.id === key),
      question = paper.questions[key];
    if (!slot || !question) throw new Error('invalid-answer-question');
    if (slot.type === 'short') {
      if (typeof answer !== 'string' || answer.length > 4000) throw new Error('invalid-answer');
      result[key] = answer;
    } else {
      if (
        !Array.isArray(answer) ||
        answer.length > question.options.length ||
        answer.some((v) => !question.options.some((o) => o.id === v)) ||
        new Set(answer).size !== answer.length ||
        (slot.type === 'single' && answer.length > 1)
      )
        throw new Error('invalid-answer');
      result[key] = [...answer].sort();
    }
  }
  return result;
}
export const answered = (answer) =>
  Array.isArray(answer)
    ? answer.length > 0
    : typeof answer === 'string' && answer.trim().length > 0;
