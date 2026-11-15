import { z } from 'zod';
import { questionTypes, objective, objectiveRubric, issueNames } from './question-types.mjs';

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
    questionTypes: z
      .array(
        z
          .object({
            type: z.enum(questionTypes),
            count: z.number().int().min(1).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(5)
      .optional(),
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
    type: z.enum(questionTypes),
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
    blanks: z
      .array(
        z
          .object({
            id: text(2),
            answers: z.array(text(100)).min(1).max(6),
            points: z.number().int().min(1).max(100),
          })
          .strict(),
      )
      .max(4)
      .optional(),
  })
  .strict();
export const wholeAuditSchema = z
  .object({
    issues: z
      .array(
        z
          .object({
            questionIds: z.array(text(12)).min(1).max(20),
            severity: z.enum(['blocking', 'advice']),
            category: z.enum(Object.keys(issueNames)),
            reason: text(500),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export const fillScoreSchema = z
  .object({
    blanks: z
      .array(
        z
          .object({
            id: text(2),
            verdict: z.enum(['correct', 'incorrect', 'uncertain']),
            explanation: text(250),
          })
          .strict(),
      )
      .min(1)
      .max(4),
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
  validateSpec(spec);
  const value = bounded(blueprintSchema.parse(raw), 6000);
  if (
    value.slots.length !== spec.questionCount ||
    value.slots.some((slot, i) => slot.id !== `q${i + 1}`) ||
    value.slots.reduce((n, s) => n + s.points, 0) !== 100 ||
    value.slots.reduce((n, s) => n + s.minutes, 0) > spec.durationMinutes ||
    value.slots.some(
      (s, i) => i && questionTypes.indexOf(s.type) < questionTypes.indexOf(value.slots[i - 1].type),
    ) ||
    (spec.questionTypes &&
      questionTypes.some(
        (type) =>
          value.slots.filter((s) => s.type === type).length !==
          (spec.questionTypes.find((s) => s.type === type)?.count ?? 0),
      ))
  )
    throw new Error('invalid-blueprint');
  return value;
}
export function validateSpec(raw) {
  const spec = specSchema.parse(raw);
  if (
    spec.questionTypes &&
    (new Set(spec.questionTypes.map((v) => v.type)).size !== spec.questionTypes.length ||
      spec.questionTypes.reduce((n, v) => n + v.count, 0) !== spec.questionCount)
  )
    throw new Error('invalid-question-types');
  return spec;
}
export const sameOptions = (a, b) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
export function validateQuestion(raw, slot) {
  const value = questionSchema.parse(raw);
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
    ['short', 'fill'].includes(slot.type)
      ? keys.length || value.correctOptions.length
      : keys.length < 2 ||
        !value.correctOptions.length ||
        (['single', 'judge'].includes(slot.type) && value.correctOptions.length !== 1) ||
        (slot.type === 'multiple' && value.correctOptions.length < 2)
  )
    throw new Error('invalid-question');
  if (
    slot.type === 'judge' &&
    JSON.stringify(value.options) !==
      JSON.stringify([
        { id: 'T', text: '正确' },
        { id: 'F', text: '错误' },
      ])
  )
    throw new Error('invalid-question');
  if (slot.type === 'fill') {
    const blanks = value.blanks ?? [];
    const tokens = [...value.stem.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
    if (
      !blanks.length ||
      blanks.reduce((n, b) => n + b.points, 0) !== slot.points ||
      blanks.some((b, i) => b.id !== `b${i + 1}`) ||
      !sameOptions(
        tokens,
        blanks.map((b) => b.id),
      )
    )
      throw new Error('invalid-question');
    value.rubric = `逐空判分：${blanks.map((b, i) => `第${i + 1}空${b.points}分`).join('，')}；与允许答案语义等价得该空满分，错误或空答零分。`;
  } else if (value.blanks?.length) throw new Error('invalid-question');
  if (objective(slot.type)) value.rubric = objectiveRubric(slot.type);
  return bounded(value, 2200, 'question-too-long');
}
export function validateAudit(raw, slots) {
  const audit = wholeAuditSchema.parse(raw);
  const ids = slots.map((s) => s.id);
  for (const issue of audit.issues) {
    if (
      new Set(issue.questionIds).size !== issue.questionIds.length ||
      issue.questionIds.some((id) => !ids.includes(id))
    )
      throw new Error('invalid-model-result');
    if (['style', 'balance'].includes(issue.category)) issue.severity = 'advice';
    if (issue.category === 'uncertainty') issue.severity = 'blocking';
  }
  return audit;
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
    } else if (slot.type === 'fill') {
      if (
        !Array.isArray(answer) ||
        answer.length !== question.blanks.length ||
        answer.some((v) => typeof v !== 'string' || v.length > 1000)
      )
        throw new Error('invalid-answer');
      result[key] = [...answer];
    } else {
      if (
        !Array.isArray(answer) ||
        answer.length > question.options.length ||
        answer.some((v) => !question.options.some((o) => o.id === v)) ||
        new Set(answer).size !== answer.length ||
        (['single', 'judge'].includes(slot.type) && answer.length > 1)
      )
        throw new Error('invalid-answer');
      result[key] = [...answer].sort();
    }
  }
  return result;
}
export const answered = (answer) =>
  Array.isArray(answer)
    ? answer.some((v) => typeof v === 'string' && v.trim().length > 0)
    : typeof answer === 'string' && answer.trim().length > 0;
