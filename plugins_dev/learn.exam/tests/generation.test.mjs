import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fiveSpec, spec, responseFor, until } from './fixtures.mjs';
import {
  validateSpec,
  validateBlueprint,
  validateQuestion,
  validateAudit,
  normalizeAnswers,
} from '../src/schemas.mjs';
import { reviewData } from '../src/review-document.mjs';
import { prompt } from '../src/prompts.mjs';
import { normalizeFill, fillParts } from '../src/fill-grading.mjs';

const issue = (ids = ['q2'], category = 'answer', severity = 'blocking') => ({
  questionIds: ids,
  category,
  severity,
  reason: 'PRIVATE-ANSWER：该题答案需要修正。',
});
const paperOf = (f) =>
  JSON.parse(f.sql.prepare('SELECT data FROM papers ORDER BY rowid DESC LIMIT 1').get().data);
const savePaper = (f, p) =>
  f.sql
    .prepare('UPDATE papers SET status=?,data=? WHERE id=?')
    .run(p.status, JSON.stringify(p), p.id);

test('五题型正常只请求七次，文档源自持久题目，建议不增加调用或泄题', async (t) => {
  const f = await fixture(t, ({ phase, data }) =>
    phase === 'whole'
      ? { issues: [issue(['q1'], 'style', 'blocking'), issue(['q3'], 'balance', 'advice')] }
      : responseFor(phase, data),
  );
  const summary = await f.service.prepare({ action: 'create', spec: fiveSpec }, f.context());
  assert.equal(summary.status, 'ready');
  assert.deepEqual(
    f.calls.map((c) => c.phase),
    ['blueprint', ...Array(5).fill('question'), 'whole'],
  );
  assert.deepEqual(f.calls.at(-1).data, reviewData(paperOf(f)));
  assert.ok(f.calls.at(-1).data.document.includes('PRIVATE-ANSWER'));
  assert.equal(JSON.stringify(summary).includes('PRIVATE-ANSWER'), false);
  assert.equal(JSON.stringify(await f.load()).includes('PRIVATE-ANSWER'), false);
  let s = await f.action('start', { paperId: summary.id });
  assert.equal(s.attempt.questions.length, 5);
  assert.deepEqual(s.attempt.questions[3].blanks, [
    { id: 'b1', points: 10 },
    { id: 'b2', points: 10 },
  ]);
  assert.equal(JSON.stringify(s).includes('PRIVATE-ANSWER'), false);
  await assert.rejects(
    f.action('save', { attemptId: s.attempt.id, expectedRevision: 0, answers: { q3: ['T', 'F'] } }),
    /invalid-answer/,
  );
  s = await f.action('save', {
    attemptId: s.attempt.id,
    expectedRevision: 0,
    answers: { q1: ['A'], q2: ['A', 'C'], q3: ['T'], q4: [' 2 ', '4'], q5: '等式性质。' },
  });
  await f.reopen();
  assert.deepEqual((await f.load()).attempt.answers.q4, [' 2 ', '4']);
  await f.action('submit', { attemptId: s.attempt.id, expectedRevision: 1 });
  assert.equal((await f.service.grade({ attemptId: s.attempt.id }, f.context())).score, 100);
  assert.equal(f.calls.filter((c) => c.phase === 'grade-fill').length, 0);
});

test('修订仍有问题只复核一次，重复执行不续费，显式继续才新开一轮', async (t) => {
  let fail = true;
  const f = await fixture(t, ({ phase, data }) =>
    fail && ['whole', 'verify'].includes(phase) ? { issues: [issue()] } : responseFor(phase, data),
  );
  const ctx = f.context(),
    input = { action: 'create', spec };
  const s = await f.service.prepare(input, ctx);
  assert.equal(s.stage, 'blocked');
  assert.equal(f.calls.length, 7); // 1+3+1+1+1
  assert.deepEqual(s.issues, [{ questionIds: ['q2'], category: 'answer' }]);
  assert.equal(JSON.stringify(await f.load()).includes('PRIVATE-ANSWER'), false);
  await f.service.prepare(input, ctx);
  await f.reopen();
  assert.equal(f.calls.length, 7);
  fail = false;
  const p = paperOf(f),
    untouched = p.questions.q1;
  assert.equal(
    (await f.service.prepare({ action: 'resume', paperId: s.id }, f.context())).status,
    'ready',
  );
  assert.deepEqual(
    f.calls.slice(7).map((c) => c.phase),
    ['repair', 'verify'],
  );
  assert.deepEqual(paperOf(f).questions.q1, untouched);
});

for (const stopAt of ['repair', 'verify'])
  test(`取消并重启后保留${stopAt}阶段与已完成修订`, async (t) => {
    let release,
      reached = false,
      gated = false;
    const gate = new Promise((r) => {
      release = r;
    });
    t.after(() => release());
    const f = await fixture(t, async ({ phase, data }) => {
      if (phase === stopAt && (phase === 'verify' || data.slot.id === 'q2') && !gated) {
        gated = true;
        reached = true;
        await gate;
      }
      return phase === 'whole' ? { issues: [issue(['q1', 'q2'])] } : responseFor(phase, data);
    });
    const work = f.service.prepare({ action: 'create', spec }, f.context());
    await until(() => reached);
    const p = paperOf(f);
    assert.equal(p.generation.stage, stopAt);
    await f.action('pause', { paperId: p.id });
    release();
    await work;
    await f.reopen();
    assert.equal(
      (await f.service.prepare({ action: 'resume', paperId: p.id }, f.context())).status,
      'ready',
    );
    assert.equal(f.calls.filter((c) => c.phase === 'whole').length, 1);
    assert.equal(f.calls.filter((c) => c.phase === 'repair' && c.data.slot.id === 'q1').length, 1);
    assert.equal(
      f.calls.filter((c) => c.phase === 'repair' && c.data.slot.id === 'q2').length,
      stopAt === 'repair' ? 2 : 1,
    );
  });

test('模拟崩溃后 verify 阶段保持，启动不重放且恢复不再次修题', async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const p = paperOf(f);
  p.status = 'preparing';
  p.operationId = 'crashed';
  p.generation.stage = 'verify';
  p.generation.changedIds = ['q2'];
  p.generation.issues = [issue()];
  p.generation.pending = [];
  savePaper(f, p);
  const count = f.calls.length;
  await f.reopen();
  assert.equal(f.calls.length, count);
  assert.equal((await f.load()).paper.status, 'paused');
  await f.service.prepare({ action: 'resume', paperId: p.id }, f.context());
  assert.deepEqual(
    f.calls.slice(count).map((c) => c.phase),
    ['verify'],
  );
});

test('旧暂停卷复用已生成题和候选，旧 ready 卷保持冻结', async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const p = paperOf(f);
  delete p.generation;
  p.questions.q1.rubric = '旧版过程分规则';
  savePaper(f, p);
  const frozen = JSON.stringify(p),
    count = f.calls.length;
  await f.service.prepare({ action: 'resume', paperId: p.id }, f.context());
  assert.equal(JSON.stringify(paperOf(f)), frozen);
  assert.equal(f.calls.length, count);
  p.status = 'paused';
  p.audit = { verdict: 'revise', questionIds: ['q1'], reason: '旧审核' };
  p.rework = ['q1'];
  p.candidates = { q3: p.questions.q3 };
  delete p.questions.q3;
  savePaper(f, p);
  await f.reopen();
  assert.equal(
    (await f.service.prepare({ action: 'resume', paperId: p.id }, f.context())).status,
    'ready',
  );
  assert.deepEqual(
    f.calls.slice(count).map((c) => c.phase),
    ['whole'],
  );
  assert.ok(paperOf(f).questions.q1.rubric.includes('不计过程分'));
});

test('格式错误至多自动重试一次并定位题号，主动继续仅补未完成题', async (t) => {
  let invalid = true;
  const f = await fixture(t, ({ phase, data }) => {
    const result = responseFor(phase, data);
    if (invalid && phase === 'question' && data.slot.id === 'q2') result.correctOptions = ['A'];
    return result;
  });
  const s = await f.prepare();
  assert.equal(s.paper.error, 'question-format-failed');
  assert.equal(s.paper.formatQuestion, 'q2');
  assert.equal(s.paper.generated, 1);
  assert.equal(f.calls.filter((c) => c.phase === 'question').length, 3);
  invalid = false;
  await f.service.prepare({ action: 'resume', paperId: s.paper.id }, f.context());
  assert.equal(f.calls.filter((c) => c.phase === 'question' && c.data.slot.id === 'q1').length, 1);
  assert.equal((await f.load()).paper.status, 'ready');
});

test('题型、填空与审核结构严格校验；不确定不能降为建议', () => {
  assert.throws(
    () => validateSpec({ ...fiveSpec, questionTypes: [{ type: 'single', count: 4 }] }),
    /invalid-question-types/,
  );
  assert.throws(
    () =>
      validateSpec({
        ...fiveSpec,
        questionTypes: [
          { type: 'single', count: 3 },
          { type: 'single', count: 2 },
        ],
      }),
    /invalid-question-types/,
  );
  const blueprint = responseFor('blueprint', fiveSpec);
  assert.throws(
    () =>
      validateBlueprint({ slots: blueprint.slots.map((s) => ({ ...s, type: 'short' })) }, fiveSpec),
    /invalid-blueprint/,
  );
  const slot = blueprint.slots[3],
    q = responseFor('question', { slot });
  assert.throws(() => validateQuestion({ ...q, stem: '[[b1]] [[b1]]' }, slot), /invalid-question/);
  assert.throws(
    () => validateQuestion({ ...q, blanks: [{ ...q.blanks[0], points: 1 }, q.blanks[1]] }, slot),
    /invalid-question/,
  );
  assert.throws(
    () => normalizeAnswers({ q4: ['2'] }, { blueprint, questions: { q4: q } }),
    /invalid-answer/,
  );
  assert.throws(
    () => validateAudit({ issues: [issue(['q99'])] }, blueprint.slots),
    /invalid-model-result/,
  );
  assert.equal(
    validateAudit({ issues: [issue(['q1'], 'uncertainty', 'advice')] }, blueprint.slots).issues[0]
      .severity,
    'blocking',
  );
  assert.notEqual(normalizeFill('x²'), normalizeFill('x2'));
  assert.notEqual(normalizeFill('x₂'), normalizeFill('x2'));
  assert.equal(normalizeFill(' e\u0301 '), 'é');
  assert.equal(
    fillParts({ blanks: [{ id: 'b1', points: 10, answers: ['x²'] }] }, ['x2'])[0].verdict,
    null,
  );
});

for (const scenario of ['partial', 'equivalent', 'uncertain', 'invalid-ids', 'empty'])
  test(`填空评分：${scenario}`, async (t) => {
    const f = await fixture(t, ({ phase, data }) => {
      if (phase === 'grade-fill') {
        assert.deepEqual(
          data.pending.map((p) => p.id),
          ['b2'],
        );
        return {
          blanks: [
            {
              id: scenario === 'invalid-ids' ? 'b1' : 'b2',
              verdict:
                scenario === 'partial'
                  ? 'incorrect'
                  : scenario === 'uncertain'
                    ? 'uncertain'
                    : 'correct',
              explanation: '逐空语义判定。',
            },
          ],
        };
      }
      return responseFor(phase, data);
    });
    const p = await f.service.prepare({ action: 'create', spec: fiveSpec }, f.context());
    let s = await f.action('start', { paperId: p.id });
    s = await f.action('save', {
      attemptId: s.attempt.id,
      expectedRevision: 0,
      answers: { q4: scenario === 'empty' ? ['', ''] : ['2', '二的平方'] },
    });
    await f.action('submit', { attemptId: s.attempt.id, expectedRevision: 1 });
    const result = await f.service.grade({ attemptId: s.attempt.id }, f.context());
    if (scenario === 'invalid-ids') {
      assert.equal(result.error, 'invalid-score');
      assert.equal(result.status, 'submitted');
    } else {
      assert.equal(
        result.score,
        scenario === 'uncertain'
          ? null
          : scenario === 'partial'
            ? 10
            : scenario === 'empty'
              ? 0
              : 20,
      );
      assert.equal(
        (await f.load()).attempt.grades.q4.verdict,
        scenario === 'empty' ? 'incorrect' : scenario === 'equivalent' ? 'correct' : scenario,
      );
    }
  });

test('20题接近每题上限、最大中文范围与全部原问题的完整复核提示在预算内', () => {
  const maxSpec = {
    ...spec,
    title: '题'.repeat(100),
    questionCount: 20,
    durationMinutes: 60,
    learningContext: '学'.repeat(6000),
  };
  const blueprint = validateBlueprint(responseFor('blueprint', maxSpec), maxSpec);
  const questions = {};
  for (const slot of blueprint.slots) {
    slot.topic = '点'.repeat(100);
    const q = responseFor('question', { slot });
    q.stem = '题'.repeat(1000);
    q.referenceAnswer = '答'.repeat(600);
    q.explanation = '解';
    q.basis = '据';
    q.rubric = '规则';
    let good = validateQuestion(q, slot);
    for (let n = 1; n < 600; n++) {
      q.explanation += '\n\\中';
      try {
        good = validateQuestion(q, slot);
      } catch {
        break;
      }
    }
    assert.ok(JSON.stringify(good).length > 2190);
    questions[slot.id] = good;
  }
  const paper = {
    spec: maxSpec,
    blueprint,
    questions,
    generation: {
      changedIds: blueprint.slots.map((s) => s.id),
      issues: blueprint.slots.map((s) => ({
        ...issue(blueprint.slots.map((v) => v.id)),
        reason: `第${s.id}题${'错\n\\'.repeat(160)}`,
      })),
    },
  };
  assert.ok(prompt('whole', reviewData(paper)).length <= 58000);
  assert.ok(prompt('verify', reviewData(paper, true)).length <= 58000);
  for (const context of ['\\'.repeat(6000), '\n\\'.repeat(3000)]) {
    paper.spec.learningContext = context;
    assert.ok(prompt('whole', reviewData(paper)).length <= 58000);
    assert.ok(prompt('verify', reviewData(paper, true)).length <= 58000);
  }
});
