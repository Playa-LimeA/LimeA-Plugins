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
async function primaryContrast(button) {
  await button.hover();
  const ratio = await button.evaluate((node) => {
    const style = getComputedStyle(node);
    const ctx = document.createElement('canvas').getContext('2d');
    const luminance = (color) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const channels = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => {
        const c = (v * 0.94) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const a = luminance(style.color),
      b = luminance(style.backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  assert.ok(ratio >= 4.5, `主按钮悬停文字对比度 ${ratio}`);
}
async function theme(page, current, next) {
  await page.getByRole('button', { name: '用户菜单', exact: true }).click();
  await page
    .getByRole('menuitem', { name: `界面主题 ${current}`, exact: true })
    .press('ArrowRight');
  await page.getByRole('menuitemradio', { name: next, exact: true }).click();
  await page.waitForFunction(
    (scheme) => document.documentElement.dataset.theme === scheme,
    next === '浅色' ? 'light' : 'dark',
  );
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
  const composer = ws.locator('.cy-composer');
  await composer.locator('textarea').fill('测试考试，');
  await page.screenshot({ path: join(artifacts, 'welcome.png') });
  await panel.getByRole('button', { name: '试卷', exact: true }).click();
  const editor = composer.locator('.ant-sender-input-slot');
  await editor.locator('.plugin-prompt-label').waitFor();
  assert.equal(publicRequests.length, 0, '插入提示不发送');
  assert.equal(
    await editor.evaluate((n) => n === document.activeElement),
    true,
    '插入后焦点回到输入框',
  );
  await editor.press('Control+A');
  await editor.press('Control+C');
  const rawPrompt = (await app.evaluate(({ clipboard }) => clipboard.readText())).replaceAll(
    '\r\n',
    '\n',
  );
  assert.ok(rawPrompt.startsWith('测试考试，'));
  assert.ok(rawPrompt.includes('请根据当前学习进度'));
  await editor.press('Control+Z');
  await composer.locator('textarea').waitFor();
  assert.equal(await composer.locator('textarea').inputValue(), '测试考试，');
  await composer.locator('textarea').press('Control+Y');
  await editor.locator('.plugin-prompt-label').waitFor();
  await panel.getByRole('button', { name: '试卷', exact: true }).click();
  assert.equal(await editor.locator('.plugin-prompt-label').count(), 1, '重复点击不堆叠');
  await app.evaluate(
    ({ clipboard }, raw) => clipboard.writeText(raw),
    rawPrompt.slice('测试考试，\n'.length),
  );
  await editor.press('Control+A');
  await editor.press('Control+V');
  await editor.locator('.plugin-prompt-label').focus();
  await editor.locator('.plugin-prompt-label').press('Enter');
  await page.locator('.plugin-prompt-popover').waitFor();
  assert.equal(publicRequests.length, 0, '查看提示不发送');
  await page.keyboard.press('Escape');
  await editor.press('Control+End');
  await editor.pressSequentially('请出5题，10分钟，五种题型各一道。');
  await primaryContrast(panel.getByRole('button', { name: '试卷', exact: true }));
  await page.screenshot({ path: join(artifacts, 'prompt-draft.png') });
  await composer.getByRole('button', { name: '发送', exact: true }).click();
  await until(() => privatePhases.includes('question'));
  await panel.getByText('已生成 0 / 5 题', { exact: true }).waitFor();
  assert.equal(await ws.locator('.sidebar-session-title-text').first().textContent(), '试卷');
  assert.ok(
    !(await ws.locator('.sidebar-session-preview').first().textContent()).includes(
      ':::limea-prompt',
    ),
  );
  await page.screenshot({ path: join(artifacts, 'preparing.png') });
  releaseQuestion();
  await panel.getByRole('button', { name: '开始考试', exact: true }).waitFor();
  assert.equal(await panel.locator('.exam-question').count(), 0);
  assert.deepEqual(privatePhases, ['blueprint', ...Array(5).fill('question'), 'whole']);
  assert.equal(saved().paper.spec.questionTypes.length, 5);
  assert.ok(publicRequests.every((b) => !JSON.stringify(b).includes('PRIVATE-ANSWER')));
  assert.ok(publicRequests.some((body) => JSON.stringify(body).includes('请出5题，10分钟')));
  assert.ok(publicRequests.some((body) => JSON.stringify(body).includes('请根据当前学习进度')));
  await primaryContrast(panel.getByRole('button', { name: '开始考试', exact: true }));
  await page.screenshot({ path: join(artifacts, 'ready.png') });
  await theme(page, '深色', '浅色');
  await primaryContrast(panel.getByRole('button', { name: '开始考试', exact: true }));
  await page.screenshot({ path: join(artifacts, 'ready-light.png') });
  await theme(page, '浅色', '深色');
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
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1900, height: 1040 }),
  );
  await delay(300);
  const separator = ws.locator('.workspace-separator').last();
  const divider = await separator.boundingBox();
  await page.mouse.move(divider.x + divider.width / 2, divider.y + 150);
  await page.mouse.down();
  await page.mouse.move(divider.x - 280, divider.y + 150, { steps: 8 });
  await page.mouse.up();
  await panel.locator('.exam-nav').waitFor();
  assert.equal(await panel.locator('.exam-number-grid button').count(), 5);
  const chatScroll = await ws.locator('.exam').evaluate(() => document.scrollingElement.scrollTop);
  await panel.locator('[data-nav-question=q1]').click();
  assert.equal(
    await panel
      .locator('[data-question=q1] h3')
      .evaluate((n) => n.getRootNode().activeElement === n),
    true,
  );
  assert.equal(await page.evaluate(() => document.scrollingElement.scrollTop), chatScroll);
  await primaryContrast(panel.getByRole('button', { name: '检查并交卷', exact: true }));
  await page.screenshot({ path: join(artifacts, 'answering.png') });
  await page.getByRole('button', { name: '用户菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '界面主题 深色', exact: true }).press('ArrowRight');
  await page.getByRole('menuitemradio', { name: '浅色', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await primaryContrast(panel.getByRole('button', { name: '检查并交卷', exact: true }));
  await page.screenshot({ path: join(artifacts, 'answering-light.png') });
  await page
    .evaluate(() => {
      document.documentElement.dataset.backgroundActive = 'wallpaper';
    })
    .catch(() => {});
  await panel.evaluate((node) => {
    node.parentElement.style.background = 'linear-gradient(125deg, #756451, #334c48 45%, #283c61)';
  });
  await page.screenshot({ path: join(artifacts, 'answering-wallpaper-light.png') });
  await page.getByRole('button', { name: '用户菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '界面主题 浅色', exact: true }).press('ArrowRight');
  await page.getByRole('menuitemradio', { name: '深色', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.screenshot({ path: join(artifacts, 'answering-wallpaper-dark.png') });
  await panel.evaluate((node) => {
    node.parentElement.style.background = '';
  });
  await page.evaluate(() => {
    delete document.documentElement.dataset.backgroundActive;
  });
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
  await panel.getByRole('button', { name: '答题卡', exact: true }).click();
  await panel.locator('.exam-nav').waitFor();
  await page.screenshot({ path: join(artifacts, 'narrow.png') });
  await panel.locator('[data-nav-question=q4]').click();
  assert.equal(await panel.locator('.exam-nav').isVisible(), false, '窄屏导航定位后收起');
  assert.equal(
    await panel
      .locator('[data-question=q4] h3')
      .evaluate((n) => n.getRootNode().activeElement === n),
    true,
  );
  assert.ok(
    await page.locator('.workspace-root:visible .plugin-prompt-label').count(),
    '重启后用户消息仍紧凑展示',
  );
  await panel.getByRole('button', { name: '检查并交卷', exact: true }).click();
  await panel.getByRole('button', { name: '确认交卷', exact: true }).click();
  await panel.getByRole('button', { name: '批改试卷', exact: true }).waitFor();
  await panel.getByRole('button', { name: '批改试卷', exact: true }).click();
  await panel.getByText('100 / 100 分', { exact: true }).waitFor();
  await panel.locator('[data-question=q5] summary').click();
  await panel.locator('.exam-content').evaluate((n) => (n.scrollTop = 0));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1450, height: 1000 }),
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1900, height: 1040 }),
  );
  await delay(300);
  if (!(await panel.locator('.exam-nav').isVisible()))
    await panel.getByRole('button', { name: '答题卡', exact: true }).click();
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
