import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

/** Exercise the shipped renderer in Electron with a controllable command transport. */
export async function panelRegressions(page, sessionId) {
  await page.evaluate(async (sessionId) => {
    const panel = (await window.limea.getPluginSettings()).plugins.find(
      (p) => p.id === 'learn.exam',
    ).panels[0];
    const base = (
      await window.limea.pluginCommand({
        pluginId: 'learn.exam',
        method: 'load-exam',
        payload: { sessionId, mode: 'learn' },
      })
    ).result;
    const module = await import(new URL(panel.entry, panel.resourceBase).href);
    const host = document.createElement('div');
    host.className = 'exam-fixture';
    host.style.cssText =
      'position:fixed;inset:50px 10px 10px auto;width:480px;z-index:10000;background:var(--background);color:var(--foreground)';
    document.body.append(host);
    const content = host.attachShadow({ mode: 'open' });
    const data = {
      base,
      host,
      content,
      module,
      panel,
      snapshots: new Map(),
      receipts: new Map(),
      calls: [],
      pending: [],
      queue: Promise.resolve(),
      current: base.attempt.id,
      mode: 'delayed-save',
      release: null,
      gate: null,
      failSave: false,
      delayLoad: false,
    };
    data.gate = new Promise((r) => {
      data.release = r;
    });
    const initial = structuredClone(base);
    initial.attempt.status = 'answering';
    initial.attempt.answers = {};
    initial.attempt.marked = [];
    initial.attempt.grades = {};
    initial.attempt.revision = 0;
    initial.attempt.deadline = Date.now() + 300000;
    initial.attempt.score = null;
    data.snapshots.set(initial.attempt.id, initial);
    data.mount = () => {
      data.controller = new AbortController();
      const controller = data.controller;
      data.cleanup = module.mount(content, {
        sessionId,
        mode: 'learn',
        resourceBase: panel.resourceBase,
        signal: controller.signal,
        onVisibilityChange(fn) {
          fn(true);
          return () => {};
        },
        onRunStateChange(fn) {
          fn(false);
          return () => {};
        },
        startRun: async () => false,
        async command(method, input) {
          controller.signal.throwIfAborted();
          if (method === 'load-exam') {
            if (data.delayLoad && input.requestId) {
              data.delayLoad = false;
              data.lookupStarted = true;
              await data.loadGate;
            }
            const snapshot = structuredClone(data.snapshots.get(input.attemptId ?? data.current));
            snapshot.serverNow = Date.now();
            snapshot.receipt = data.receipts.get(input.requestId) ?? null;
            return snapshot;
          }
          data.calls.push(structuredClone(input));
          const work = data.queue.then(async () => {
            if (data.mode === 'delayed-save') await data.gate;
            const current = structuredClone(data.snapshots.get(input.attemptId ?? data.current));
            if (input.action === 'save') {
              if (data.failSave) {
                data.failSave = false;
                throw new Error('simulated-offline');
              }
              if (input.expectedRevision !== current.attempt.revision)
                throw new Error('revision-conflict');
              current.attempt.answers = input.answers;
              current.attempt.marked = input.marked;
              current.attempt.revision++;
            } else if (input.action === 'start') {
              current.attempt.id = 'new-attempt-after-lost-response';
              current.attempt.status = 'answering';
              current.attempt.answers = {};
              current.attempt.grades = {};
              current.attempt.revision = 0;
              current.attempt.deadline = Date.now() + 300000;
              current.attempt.score = null;
              data.current = current.attempt.id;
            }
            const receipt = {
              action: input.action,
              paperId: current.paper.id,
              attemptId: current.attempt.id,
              revision: current.attempt.revision,
            };
            data.receipts.set(input.requestId, receipt);
            current.receipt = receipt;
            data.snapshots.set(current.attempt.id, current);
            if (input.action === 'start' && data.mode === 'lost-start')
              throw new Error('reply-lost');
            return structuredClone(current);
          });
          data.queue = work.catch(() => {});
          data.pending.push(work.catch(() => {}));
          const result = await work;
          controller.signal.throwIfAborted();
          return result;
        },
      });
    };
    data.unmount = () => {
      data.controller.abort();
      data.cleanup();
    };
    window.__examFixture = data;
    data.mount();
  }, sessionId);
  const panel = page.locator('.exam-fixture .exam');
  const answer = () => panel.getByLabel('第3题作答', { exact: true });
  await answer().waitFor();
  await answer().fill('第一段');
  await answer().fill('连续输入的第二段');
  assert.equal(
    await page.evaluate(() => window.__examFixture.calls.length),
    2,
    '两个编辑必须在回执前都已派发',
  );
  await page.evaluate(async () => {
    const f = window.__examFixture;
    f.unmount();
    f.release();
    await Promise.all(f.pending);
    f.mode = 'normal';
    f.mount();
  });
  await answer().waitFor();
  assert.equal(await answer().inputValue(), '连续输入的第二段', '卸载不丢失最新已派发编辑');

  // Fail one save, hold the receipt lookup during user retry, and type again.
  await page.evaluate(() => {
    window.__examFixture.failSave = true;
  });
  await answer().fill('需要核对的旧草稿');
  await panel.getByRole('button', { name: '重试保存', exact: true }).waitFor();
  await page.evaluate(() => {
    const f = window.__examFixture;
    f.delayLoad = true;
    f.loadGate = new Promise((r) => {
      f.releaseLoad = r;
    });
  });
  await panel.getByRole('button', { name: '重试保存', exact: true }).click();
  await page.waitForFunction(() => window.__examFixture.lookupStarted);
  await answer().fill('核对期间输入的新内容');
  await page.evaluate(() => window.__examFixture.releaseLoad());
  await delay(100);
  assert.equal(await answer().inputValue(), '核对期间输入的新内容');
  // Conflicts remain explicit; a second user retry reconciles the latest draft.
  if (await panel.getByRole('button', { name: '重试保存', exact: true }).count())
    await panel.getByRole('button', { name: '重试保存', exact: true }).click();
  await page.waitForFunction(() => {
    const f = window.__examFixture;
    return f.snapshots.get(f.current).attempt.answers.q3 === '核对期间输入的新内容';
  });
  assert.equal(await answer().inputValue(), '核对期间输入的新内容');

  await page.evaluate(() => {
    const f = window.__examFixture;
    f.unmount();
    f.mode = 'lost-start';
    f.receipts.clear();
    const old = structuredClone(f.base);
    old.attempts.push({ ...old.attempts[0], id: 'older-attempt' });
    f.current = old.attempt.id;
    f.snapshots.set(old.attempt.id, old);
    f.mount();
  });
  await panel.getByRole('button', { name: '再做一次', exact: true }).waitFor();
  const history = panel.getByLabel('试卷与作答记录');
  await history.evaluate((node) => node.dispatchEvent(new Event('change', { bubbles: true })));
  await panel.getByRole('button', { name: '再做一次', exact: true }).click();
  await panel.locator('time').waitFor();
  assert.equal(await panel.getAttribute('data-status'), 'answering', '丢失开始回执后转到新作答');
  assert.equal(await answer().inputValue(), '');
  await page.evaluate(() => {
    const f = window.__examFixture;
    f.unmount();
    f.host.remove();
    delete window.__examFixture;
  });
  console.log('面板回归通过：连续编辑后卸载、重试核对期间继续输入、丢失重考回执。');
}
