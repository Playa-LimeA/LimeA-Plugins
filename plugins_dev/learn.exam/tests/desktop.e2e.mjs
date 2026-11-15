import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { responseFor, fiveSpec as spec, parsePrompt } from './fixtures.mjs';
import { panelRegressions } from './panel-regressions.mjs';
const host = process.env.LIMEA_REPO_DIR;
assert.ok(host && process.env.LIMEA_TEST_APP_DIR, '设置 LIMEA_REPO_DIR 与 LIMEA_TEST_APP_DIR');
const requireHost = createRequire(join(host, 'package.json'));
const { _electron: electron } = requireHost('playwright');
const { readProtocolStream } = await import(
  pathToFileURL(join(host, 'tests/fixtures/read-protocol-stream.ts'))
);
const { protocolStream } = await import(
  pathToFileURL(join(host, 'tests/fixtures/model-protocol-stream.ts'))
);
const plugin = fileURLToPath(new URL('..', import.meta.url)),
  artifacts = join(plugin, 'artifacts');
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'limea-exam-')),
  profile = join(root, 'profile');
const env = { ...process.env, LIMEA_USER_DATA_DIR: profile, LIMEA_DISABLE_SANDBOX_SETUP: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
let app,
  releaseQuestion,
  firstQuestion = true;
const questionGate = new Promise((r) => {
  releaseQuestion = r;
});
const errors = [],
  logs = [],
  publicRequests = [],
  privatePhases = [],
  handledTurns = new Set();
const textOf = (message) =>
  typeof message?.content === 'string'
    ? message.content
    : (message?.content ?? [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('');
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()),
      names = (body.tools ?? []).map((t) => t.function.name);
    const respond = names.find((n) => n.endsWith('_respond'));
    let stream;
    if (respond) {
      assert.equal(names.length, 1);
      assert.equal(body.messages.filter((m) => m.role === 'user').length, 1);
      assert.equal(body.messages.filter((m) => m.role === 'system').length, 0);
      const text = textOf(body.messages.find((m) => m.role === 'user'));
      const { phase, data } = parsePrompt({ prompt: text });
      privatePhases.push(phase);
      if (phase === 'question' && firstQuestion) {
        firstQuestion = false;
        await questionGate;
      }
      stream = readProtocolStream('chat-completions', responseFor(phase, data), {
        name: respond,
        callId: `private-${privatePhases.length}`,
      });
    } else {
      publicRequests.push(body);
      const lastUser = [...body.messages]
          .reverse()
          .find(
            (m) =>
              m.role === 'user' &&
              (textOf(m).includes('请根据当前学习进度') || textOf(m).includes('请批改《')),
          ),
        text = textOf(lastUser);
      if (handledTurns.has(text))
        stream = protocolStream('chat-completions', { chunks: ['试卷任务已处理，请在右侧查看。'] });
      else if (text.includes('作答编号：')) {
        handledTurns.add(text);
        const attemptId = text.match(/作答编号：([a-f0-9-]+)/)?.[1];
        stream = readProtocolStream(
          'chat-completions',
          { attemptId },
          {
            name: names.find((n) => n.endsWith('_grade')),
            callId: `grade-${publicRequests.length}`,
          },
        );
      } else {
        handledTurns.add(text);
        stream = readProtocolStream(
          'chat-completions',
          { action: 'create', spec },
          {
            name: names.find((n) => n.endsWith('_prepare')),
            callId: `prepare-${publicRequests.length}`,
          },
        );
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(stream);
  } catch (error) {
    errors.push(error.stack);
    res.writeHead(500);
    res.end('{}');
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
function saved() {
  const db = new DatabaseSync(
    join(profile, 'storage/plugin-data/learn.exam/databases/exam.sqlite'),
    { readOnly: true },
  );
  try {
    return {
      paper: JSON.parse(
        db.prepare('SELECT data FROM papers ORDER BY rowid DESC LIMIT 1').get()?.data ?? 'null',
      ),
      attempt: JSON.parse(
        db.prepare('SELECT data FROM attempts ORDER BY rowid DESC LIMIT 1').get()?.data ?? 'null',
      ),
    };
  } finally {
    db.close();
  }
}
async function until(check, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error('等待状态超时');
}
async function launch() {
  app = await electron.launch({
    executablePath: requireHost('electron'),
    args: [resolve(process.env.LIMEA_TEST_APP_DIR)],
    env,
  });
  app.process().stdout?.on('data', (v) => logs.push(v.toString()));
  app.process().stderr?.on('data', (v) => logs.push(v.toString()));
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => errors.push(e.stack));
  page.on('console', (m) => {
    if (m.type() === 'error') logs.push(m.text());
  });
  await page.waitForFunction(
    async () => (await window.limea?.getStartupState())?.phase === 'shell-ready',
  );
  await page.waitForFunction(async () => {
    try {
      await window.limea.getPluginSettings();
      return true;
    } catch {
      return false;
    }
  });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1450, height: 1000 }),
  );
  return page;
}
async function openPanel(page, resume = false) {
  const ws = page.locator('.workspace-root:visible');
  await ws.locator('.cy-mode-switch').getByText('Learn', { exact: true }).click();
  if (resume) {
    await ws.locator('.sidebar-session').first().click();
  }
  if (
    (await ws.locator('.workspace-content-layout').getAttribute('data-details-collapsed')) ===
    'true'
  )
    await ws.locator('.cy-sidebar-toggle[data-side=right]').click();
  if (!(await ws.locator('.exam').count())) {
    const launcher = ws
      .locator('.details-launcher')
      .getByRole('button', { name: '试卷', exact: true });
    if (await launcher.count()) await launcher.click();
    else {
      await ws.getByRole('button', { name: '添加工作区标签', exact: true }).click();
      await page
        .locator('.workspace-tab-menu')
        .getByRole('button', { name: '试卷', exact: true })
        .click();
    }
  }
  await ws.locator('.exam').waitFor();
  return ws.locator('.exam');
}
try {
  let page = await launch();
  await app.evaluate(
    ({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    },
    join(plugin, 'dist'),
  );
  await page.evaluate(async (baseURL) => {
    await window.limea.importPlugin();
    await window.limea.setPluginEnabled({ pluginId: 'learn.exam', enabled: true });
    const channel = (await window.limea.listModelServices())
      .flatMap((v) => v.channels)
      .find((c) => c.providerId === 'deepseek');
    await window.limea.saveModelSettings({
      name: '试卷本机验证',
      providerId: channel.providerId,
      protocol: 'chat-completions',
      baseURL,
      makeActive: true,
      apiKey: 'local-test-only',
      defaultOfferingId: channel.defaultOfferingId,
      models: [{ offeringId: channel.defaultOfferingId, settings: { maxOutputTokens: 4096 } }],
    });
  }, `http://127.0.0.1:${server.address().port}/v1`);
  await page.reload();
  await page.waitForFunction(
    async () => (await window.limea?.getStartupState())?.phase === 'shell-ready',
  );
  const ws = page.locator('.workspace-root:visible');
  assert.equal(
    await ws
      .locator('.details-launcher')
      .getByRole('button', { name: '试卷', exact: true })
      .count(),
    0,
    'Work不可见',
  );
  let panel = await openPanel(page);
  await panel.getByLabel('题数', { exact: true }).fill('5');
  await panel.getByLabel('考试时长（分钟）', { exact: true }).fill('10');
  await panel.getByText('题型分配 · 默认自动规划', { exact: true }).click();
  await panel.getByLabel('指定每种题型的数量', { exact: true }).check();
  for (const name of ['单选', '多选', '判断', '填空', '解答'])
    await panel.getByLabel(`${name}题数量`, { exact: true }).fill('1');
  await panel.getByRole('button', { name: '根据学习进度出卷', exact: true }).click();
  await until(() => privatePhases.includes('question'));
  await panel.getByText('已生成 0 / 5 题', { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, 'preparing.png') });
  releaseQuestion();
  await panel.getByRole('button', { name: '开始考试', exact: true }).waitFor();
  assert.equal(await panel.locator('.exam-question').count(), 0);
  assert.deepEqual(privatePhases, ['blueprint', ...Array(5).fill('question'), 'whole']);
  assert.equal(saved().paper.spec.questionTypes.length, 5);
  assert.ok(publicRequests.every((b) => !JSON.stringify(b).includes('PRIVATE-ANSWER')));
  await panel.getByRole('button', { name: '开始考试', exact: true }).click();
  await panel.locator('[data-question=q1]').waitFor();
  await panel.locator('[data-question=q1] input[value=A]').check();
  await panel.locator('[data-question=q2] input[value=A]').check();
  await panel.locator('[data-question=q2] input[value=C]').check();
  await panel.locator('[data-question=q3] input[value=F]').check();
  await panel.locator('[data-question=q3] input[value=T]').check();
  assert.equal(await panel.locator('[data-question=q3] input:checked').count(), 1);
  await panel.getByLabel('第4题第1空', { exact: true }).fill('2');
  await panel.getByLabel('第4题第2空', { exact: true }).fill('二的平方');
  const answer = panel.getByLabel('第5题作答', { exact: true });
  await answer.fill('等量增加相同的量后仍然相等。');
  await until(() => saved().attempt?.answers.q5 === '等量增加相同的量后仍然相等。');
  await answer.focus();
  await answer.press('Enter');
  await answer.pressSequentially('这是我的解释。');
  await until(() => saved().attempt?.answers.q5.includes('这是我的解释。'));
  assert.equal(
    await answer.evaluate((node) => node.getRootNode().activeElement === node),
    true,
    '保存不抢焦点',
  );
  assert.equal(saved().attempt.status, 'answering', 'Enter不提交试卷');
  assert.ok((await panel.locator('.katex').count()) > 0, '真实公式渲染');
  await panel.locator('[data-question=q5]').getByRole('button', { name: '标记待检查' }).click();
  await until(() => saved().attempt.marked.includes('q5'));
  await page.screenshot({ path: join(artifacts, 'answering.png') });
  const before = saved().attempt;
  // Hide the entire workspace; the deadline and answer state remain authoritative.
  await ws.locator('.cy-mode-switch').getByText('Work', { exact: true }).click();
  await delay(1000);
  await page
    .locator('.workspace-root:visible .cy-mode-switch')
    .getByText('Learn', { exact: true })
    .click();
  assert.equal(saved().attempt.deadline, before.deadline);
  await app.close();
  app = null;
  page = await launch();
  panel = await openPanel(page, true);
  await panel.getByLabel('第5题作答', { exact: true }).waitFor();
  assert.equal(
    await panel.getByLabel('第5题作答', { exact: true }).inputValue(),
    before.answers.q5,
  );
  assert.equal(saved().attempt.deadline, before.deadline);
  assert.equal(await panel.getByLabel('第4题第1空', { exact: true }).inputValue(), '2');
  assert.equal(await panel.getByLabel('第4题第2空', { exact: true }).inputValue(), '二的平方');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 960, height: 850 }),
  );
  await delay(300);
  assert.ok(await panel.evaluate((n) => n.scrollWidth <= n.clientWidth + 1), '窄面板没有横向溢出');
  await page.screenshot({ path: join(artifacts, 'narrow.png') });
  await panel.getByRole('button', { name: '检查并交卷', exact: true }).click();
  await panel.getByRole('button', { name: '确认交卷', exact: true }).click();
  await panel.getByRole('button', { name: '批改试卷', exact: true }).waitFor();
  await panel.getByRole('button', { name: '批改试卷', exact: true }).click();
  await panel.getByText('100 / 100 分', { exact: true }).waitFor();
  await panel.locator('[data-question=q5] summary').click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1450, height: 1000 }),
  );
  await page.screenshot({ path: join(artifacts, 'results.png') });
  assert.equal(saved().attempt.status, 'graded');
  assert.equal(privatePhases.filter((p) => p === 'grade').length, 1);
  assert.equal(privatePhases.filter((p) => p === 'grade-fill').length, 1);
  await panelRegressions(page, saved().paper.sessionId);
  assert.deepEqual(errors, []);
  console.log(
    '桌面验证通过：模式过滤、五题型、五题七请求、整卷审核、保密、作答保存与焦点、重启、计时、公式、窄面板、交卷批改。',
  );
} catch (error) {
  if (app)
    await (
      await app.firstWindow()
    )
      .screenshot({ path: join(artifacts, 'failure.png') })
      .catch(() => {});
  throw error;
} finally {
  releaseQuestion();
  await app?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await writeFile(join(artifacts, 'desktop-log.txt'), [...errors, ...logs].join('\n'));
  const resolved = resolve(root),
    base = resolve(tmpdir());
  if (resolved.startsWith(`${base}\\`) || resolved.startsWith(`${base}/`))
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
