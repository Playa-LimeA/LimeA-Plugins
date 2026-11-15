import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, scope, spec, answers, responseFor, until } from './fixtures.mjs';
import { prompt } from '../src/prompts.mjs';
import { publicResult, validateBlueprint, validateQuestion } from '../src/schemas.mjs';
import { createModelTasks } from '../src/model-tasks.mjs';
import { createRepository } from '../src/repository.mjs';
import { createExam } from '../src/exam.mjs';

test('完整出卷、答案隔离、提交、程序判分与主观评分', async (t) => {
  const f = await fixture(t),
    context = f.context();
  const summary = await f.service.prepare({ action: 'create', spec }, context);
  assert.equal(summary.status, 'ready');
  assert.equal(f.calls.filter((c) => c.phase === 'question').length, 3);
  assert.ok(!JSON.stringify(summary).includes('PRIVATE-ANSWER'));
  const preview = await f.load();
  assert.equal(preview.attempt, null);
  assert.ok(!JSON.stringify(preview).includes('PRIVATE-ANSWER'));
  let state = await f.action('start', { paperId: summary.id });
  assert.ok(!JSON.stringify(state).includes('PRIVATE-ANSWER'));
  assert.equal(state.attempt.questions[0].correctOptions, undefined);
  await assert.rejects(
    f.service.review({ attemptId: state.attempt.id, questionId: 'q1' }, f.context()),
    /exam-not-submitted/,
  );
  state = await f.action('save', { attemptId: state.attempt.id, expectedRevision: 0, answers });
  state = await f.action('submit', { attemptId: state.attempt.id, expectedRevision: 1 });
  assert.equal(state.attempt.status, 'submitted');
  assert.ok(JSON.stringify(state).includes('PRIVATE-ANSWER'));
  const result = await f.service.grade({ attemptId: state.attempt.id }, f.context());
  assert.equal(result.score, 100);
  assert.equal(result.status, 'graded');
  assert.equal(f.calls.filter((c) => c.phase === 'grade').length, 1);
  assert.ok(
    f.calls.every((c) => c.phase !== 'solve' || !JSON.stringify(c.data).includes('PRIVATE-ANSWER')),
  );
  const detail = await f.service.review(
    { attemptId: state.attempt.id, questionId: 'q1' },
    f.context(),
  );
  assert.equal(detail.grade.score, 34);
});

test('工具执行标识与面板回执幂等，复用编号不能改变内容', async (t) => {
  const f = await fixture(t),
    ctx = f.context(),
    input = { action: 'create', spec };
  const first = await f.service.prepare(input, ctx),
    count = f.calls.length;
  assert.equal((await f.service.prepare(input, ctx)).id, first.id);
  assert.equal(f.calls.length, count);
  const start = { paperId: first.id, requestId: 'same-start' };
  const a = await f.action('start', start),
    b = await f.action('start', start);
  assert.equal(a.attempt.id, b.attempt.id);
  const save = { requestId: 'same-save', attemptId: a.attempt.id, expectedRevision: 0, answers };
  await f.action('save', save);
  assert.equal((await f.action('save', save)).attempt.revision, 1);
  await assert.rejects(f.action('save', { ...save, answers: {} }), /operation-conflict/);
  await assert.rejects(
    f.action('save', { attemptId: a.attempt.id, expectedRevision: 0, answers: {} }),
    /revision-conflict/,
  );
});

test('回执丢失后查持久结果，开始和交卷不会重复', async (t) => {
  const f = await fixture(t),
    p = await f.prepare();
  const original = f.db.transaction;
  const dropNextReceipt = () => {
    let dropped = false;
    f.db.transaction = async (entries) => {
      const result = await original(entries);
      if (!dropped && entries.some((v) => v.sql.startsWith('INSERT INTO operations'))) {
        dropped = true;
        throw new Error('reply-lost');
      }
      return result;
    };
  };
  dropNextReceipt();
  await assert.rejects(
    f.action('start', { paperId: p.paper.id, requestId: 'lost-start' }),
    /reply-lost/,
  );
  let state = await f.load({ requestId: 'lost-start' });
  assert.equal(state.receipt.attemptId, state.attempt.id);
  assert.equal(
    (await f.action('start', { paperId: p.paper.id, requestId: 'lost-start' })).attempt.id,
    state.attempt.id,
  );
  dropNextReceipt();
  await assert.rejects(
    f.action('submit', {
      attemptId: state.attempt.id,
      expectedRevision: 0,
      requestId: 'lost-submit',
    }),
    /reply-lost/,
  );
  state = await f.load({ requestId: 'lost-submit' });
  assert.equal(state.attempt.status, 'submitted');
  assert.ok(state.receipt);
  assert.equal(
    (
      await f.action('submit', {
        attemptId: state.attempt.id,
        expectedRevision: 0,
        requestId: 'lost-submit',
      })
    ).attempt.status,
    'submitted',
  );
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM attempts').get().n, 1);
});

test('截止与异步保存竞争只封存旧答案', async (t) => {
  const f = await fixture(t);
  let state = await f.start();
  state = await f.action('save', {
    attemptId: state.attempt.id,
    expectedRevision: 0,
    answers: { q1: ['B'] },
  });
  f.now = state.attempt.deadline - 1;
  const get = f.db.get;
  f.db.get = async (...args) => {
    const result = await get(...args);
    if (args[0].includes('FROM operations')) f.now = state.attempt.deadline + 1;
    return result;
  };
  await assert.rejects(
    f.action('save', { attemptId: state.attempt.id, expectedRevision: 1, answers }),
    /exam-closed/,
  );
  const ended = await f.load();
  assert.equal(ended.attempt.status, 'submitted');
  assert.equal(ended.attempt.submitReason, 'timeout');
  assert.deepEqual(ended.attempt.answers, { q1: ['B'] });
});

test('重启后时间继续，过期拒绝新答案且保留已存作答', async (t) => {
  const f = await fixture(t);
  let s = await f.start();
  s = await f.action('save', { attemptId: s.attempt.id, expectedRevision: 0, answers });
  const deadline = s.attempt.deadline;
  await f.reopen();
  assert.equal((await f.load()).attempt.deadline, deadline);
  f.now = deadline;
  await f.reopen();
  assert.equal((await f.load()).attempt.status, 'submitted');
  await assert.rejects(
    f.action('save', { attemptId: s.attempt.id, expectedRevision: 1, answers: {} }),
    /exam-closed/,
  );
  assert.deepEqual((await f.load()).attempt.answers, answers);
});

test('跨会话对象拒绝；每会话最多一份活动作答', async (t) => {
  const f = await fixture(t),
    s = await f.start();
  await assert.rejects(
    f.service.load({ ...scope, sessionId: 'other', attemptId: s.attempt.id }),
    /not-found/,
  );
  await assert.rejects(
    f.service.review({ attemptId: s.attempt.id }, f.context({ sessionId: 'other' })),
    /not-found/,
  );
  await assert.rejects(
    f.service.prepare({ action: 'create', spec }, f.context()),
    /exam-already-active/,
  );
  const second = await f.service.prepare(
    { action: 'create', spec },
    f.context({ sessionId: 'other' }),
  );
  assert.equal(second.status, 'ready');
});

test('暂停丢弃迟到结果，主动继续保留已审核题', async (t) => {
  let release,
    gateReached = false,
    gated = false;
  const gate = new Promise((r) => {
    release = r;
  });
  const f = await fixture(t, async ({ phase, data }) => {
    if (phase === 'question' && data.slot.id === 'q2' && !gated) {
      gated = true;
      gateReached = true;
      await gate;
    }
    return responseFor(phase, data);
  });
  const work = f.service.prepare({ action: 'create', spec }, f.context());
  await until(() => gateReached);
  const s = await f.load();
  assert.equal(s.paper.approved, 1);
  await f.action('pause', { paperId: s.paper.id });
  release();
  await work;
  assert.equal((await f.load()).paper.approved, 1);
  assert.equal(
    (await f.service.prepare({ action: 'resume', paperId: s.paper.id }, f.context())).status,
    'ready',
  );
  assert.equal(f.calls.filter((c) => c.phase === 'question' && c.data.slot.id === 'q1').length, 1);
  assert.equal(
    f.sql.prepare("SELECT count(*) AS n FROM model_requests WHERE status='cancelled'").get().n,
    1,
  );
});

test('整卷审核返工仅针对指定题并重新审核整卷', async (t) => {
  let checks = 0;
  const f = await fixture(t, ({ phase, data }) =>
    phase === 'whole' && checks++ === 0
      ? { verdict: 'revise', questionIds: ['q2'], reason: 'q2与前题提示重复，请调整。' }
      : responseFor(phase, data),
  );
  assert.equal((await f.prepare()).paper.status, 'ready');
  assert.equal(f.calls.filter((c) => c.phase === 'question' && c.data.slot.id === 'q2').length, 2);
  assert.equal(f.calls.filter((c) => c.phase === 'question' && c.data.slot.id === 'q1').length, 1);
  assert.equal(checks, 2);
});

test('审核不确定经过有界修订后暂停，不发布有争议试卷', async (t) => {
  const f = await fixture(t, ({ phase, data }) =>
    phase === 'audit'
      ? { verdict: 'uncertain', reason: '缺少足够依据。' }
      : responseFor(phase, data),
  );
  const s = await f.prepare();
  assert.equal(s.paper.status, 'paused');
  assert.equal(s.paper.approved, 0);
  assert.equal(f.calls.filter((c) => c.phase === 'question').length, 3);
  await assert.rejects(f.action('start', { paperId: s.paper.id }), /paper-not-ready/);
});

test('批改中断保留已评分项，不确定分值不生成确定总分', async (t) => {
  let fail = true;
  const f = await fixture(t, ({ phase, data }) => {
    if (phase === 'grade') {
      if (fail) throw new Error('network-failed');
      return { verdict: 'uncertain', score: null, explanation: '本题需要人工复核。' };
    }
    return responseFor(phase, data);
  });
  let s = await f.start();
  s = await f.action('save', { attemptId: s.attempt.id, expectedRevision: 0, answers });
  await f.action('submit', { attemptId: s.attempt.id, expectedRevision: 1 });
  let result = await f.service.grade({ attemptId: s.attempt.id }, f.context());
  assert.equal(result.status, 'submitted');
  assert.equal(result.graded, 2);
  await f.reopen();
  fail = false;
  result = await f.service.grade({ attemptId: s.attempt.id }, f.context());
  assert.equal(result.status, 'graded');
  assert.equal(result.score, null);
  assert.equal(result.uncertain, 1);
  assert.equal(result.confirmedScore, 67);
});

test('停用等待尚在数据库准入阶段的任务，关闭后不进入模型工作', async (t) => {
  const f = await fixture(t),
    p = await f.prepare();
  const repo = createRepository(f.db, () => f.now),
    tasks = createModelTasks(repo, () => f.now);
  let release,
    reached = false,
    worked = false;
  const gate = new Promise((r) => {
    release = r;
  });
  const get = repo.get;
  repo.get = async (...args) => {
    reached = true;
    await gate;
    return get(...args);
  };
  const job = tasks
    .run('paper', p.paper.id, f.context(), async () => {
      worked = true;
    })
    .catch((e) => e);
  await until(() => reached);
  let disposed = false;
  const cleanup = tasks.dispose().then(() => {
    disposed = true;
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(disposed, false);
  release();
  await job;
  await cleanup;
  assert.equal(worked, false);
});

test('最大题量与中文预算在请求前校验', () => {
  const spec20 = {
    ...spec,
    questionCount: 20,
    durationMinutes: 60,
    learningContext: '学'.repeat(6000),
  };
  const blueprint = validateBlueprint(responseFor('blueprint', spec20), spec20),
    questions = {};
  for (const slot of blueprint.slots)
    questions[slot.id] = validateQuestion(responseFor('question', { slot }), slot);
  assert.ok(prompt('whole', { spec: spec20, blueprint, questions }).length <= 58000);
  assert.throws(() => prompt('whole', { content: '中'.repeat(58000) }), /prompt-too-long/);
  assert.throws(() => publicResult({ content: '中'.repeat(9000) }), /public-result-limit/);
});

test('后台定时器在没有面板读取时封卷', async (t) => {
  const f = await fixture(t),
    s = await f.start();
  const background = await createExam(f.db, { now: () => f.now, sweepInterval: 5 });
  try {
    f.now = s.attempt.deadline;
    await until(
      () =>
        f.sql.prepare('SELECT status FROM attempts WHERE id=?').get(s.attempt.id).status ===
        'submitted',
    );
    assert.equal(
      JSON.parse(f.sql.prepare('SELECT data FROM attempts WHERE id=?').get(s.attempt.id).data)
        .submitReason,
      'timeout',
    );
  } finally {
    await background.dispose();
  }
});

test('启动恢复中断批改和请求日志，不自动调用模型', async (t) => {
  const f = await fixture(t),
    s = await f.start();
  await f.action('submit', { attemptId: s.attempt.id, expectedRevision: 0 });
  const a = JSON.parse(
    f.sql.prepare('SELECT data FROM attempts WHERE id=?').get(s.attempt.id).data,
  );
  a.status = 'grading';
  a.operationId = 'crashed-task';
  f.sql
    .prepare('UPDATE attempts SET status=?,data=? WHERE id=?')
    .run(a.status, JSON.stringify(a), a.id);
  f.sql
    .prepare(
      'INSERT INTO model_requests(id,session_id,target_id,operation_id,phase,status,started_at,input) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(
      'crashed-request',
      a.sessionId,
      a.id,
      'crashed-task',
      'grade',
      'running',
      f.now,
      'fixture',
    );
  const count = f.calls.length;
  await f.reopen();
  const state = await f.load();
  assert.equal(state.attempt.status, 'submitted');
  assert.equal(state.attempt.error, 'interrupted');
  assert.equal(f.calls.length, count);
  assert.equal(
    f.sql.prepare('SELECT status FROM model_requests WHERE id=?').get('crashed-request').status,
    'interrupted',
  );
});

test('主观题越界分数被拒绝，已交卷答案不改变', async (t) => {
  const f = await fixture(t, ({ phase, data }) =>
    phase === 'grade'
      ? { verdict: 'correct', score: 100, explanation: '无效的越界分数。' }
      : responseFor(phase, data),
  );
  let s = await f.start();
  s = await f.action('save', { attemptId: s.attempt.id, expectedRevision: 0, answers });
  await f.action('submit', { attemptId: s.attempt.id, expectedRevision: 1 });
  const result = await f.service.grade({ attemptId: s.attempt.id }, f.context());
  assert.equal(result.status, 'submitted');
  assert.equal(result.error, 'invalid-score');
  assert.deepEqual((await f.load()).attempt.answers, answers);
});
