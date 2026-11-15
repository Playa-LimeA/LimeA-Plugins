import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const host = resolve(process.env.LIMEA_REPO_DIR ?? '../../../..');
const requireHost = createRequire(join(host, 'package.json'));
const { _electron: electron } = requireHost('playwright');
const plugin = fileURLToPath(new URL('..', import.meta.url));
const captures = join(plugin, '.impeccable/review');
await mkdir(captures, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'limea-exam-page-'));
const env = { ...process.env, LIMEA_USER_DATA_DIR: profile, LIMEA_DISABLE_SANDBOX_SETUP: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
let app;
try {
  app = await electron.launch({ executablePath: requireHost('electron'), args: [host], env });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
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
  await app.evaluate(
    ({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    },
    join(plugin, 'dist'),
  );
  await page.evaluate(async () => {
    await window.limea.importPlugin();
    await window.limea.setPluginEnabled({ pluginId: 'learn.exam', enabled: true });
  });
  await page.locator('.workspace-root:visible .sidebar-settings').click();
  const openPage = async (english = false) => {
    await page
      .locator('.settings-navigation:visible')
      .getByRole('button', { name: english ? 'Plugins' : '插件', exact: true })
      .click();
    await page
      .getByRole('article', { name: '学习试卷', exact: true })
      .getByRole('button', { name: english ? 'Open plugin' : '打开插件', exact: true })
      .click();
    await page.locator('.exam-page').waitFor();
  };
  await openPage();
  const detail = page.locator('.plugin-detail-page:visible');
  await page.waitForFunction(() => {
    const image = document.querySelector('.plugin-detail-illustration');
    return image?.complete && image.naturalWidth === 1671;
  });
  assert.equal(await detail.locator('.exam-page .features li').count(), 6);
  assert.equal(await detail.locator('[data-plugin-settings-control="icon"]').count(), 8);
  assert.equal(await detail.locator('.exam-page button').count(), 0);
  async function capture(name, width, theme) {
    await app.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setBounds({ width, height: 1000 }),
      width,
    );
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme) {
      await page.evaluate(async (theme) => {
        const appearance = await window.limea.getAppearanceSettings();
        await window.limea.saveAppearanceSettings({ ...appearance, colorScheme: theme });
      }, theme);
      await page.reload();
      await page.waitForFunction(
        async () => (await window.limea?.getStartupState())?.phase === 'shell-ready',
      );
      await page.locator('.workspace-root:visible .sidebar-settings').click();
      await openPage((await page.evaluate(() => document.documentElement.lang)) === 'en-US');
    }
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
    await detail.evaluate((element) => element.scrollTo(0, 0));
    assert.equal(
      await detail.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      true,
    );
    await page.screenshot({ path: join(captures, `${name}.png`) });
    await detail.locator('.exam-page .features').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(captures, `${name}-features.png`) });
    if (['page-desktop-light', 'page-narrow-dark', 'page-english'].includes(name)) {
      await detail.locator('.exam-page .usage').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(captures, `${name}-usage.png`) });
    }
  }
  await capture('page-desktop-light', 1440, 'light');
  await capture('page-desktop-dark', 1440, 'dark');
  await capture('page-narrow-light', 960, 'light');
  await capture('page-narrow-dark', 960, 'dark');
  await detail.getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('article', { name: '学习试卷', exact: true }).waitFor();
  assert.equal(await page.locator('.exam-page').count(), 0);
  assert.equal(await page.locator('.plugin-manager-open-title:focus').count(), 1);
  await page.locator('.settings-back:visible').click();
  await page.locator('button.sidebar-profile:visible').click();
  const language = page.getByRole('menuitem', { name: /^界面语言/ });
  await language.focus();
  await language.press('ArrowRight');
  await page.getByRole('menuitemradio', { name: 'English', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'en-US');
  await page.locator('.workspace-root:visible .sidebar-settings').click();
  await openPage(true);
  await detail.getByRole('heading', { name: /^Plugin features/ }).waitFor();
  await capture('page-english', 1440, 'light');
  await detail.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.getByRole('button', { name: 'Disable plugin', exact: true }).click();
  await detail.locator('.plugin-detail-unavailable').waitFor();
  assert.equal(await detail.locator('.plugin-surface').count(), 0);
  await detail.evaluate((element) => element.scrollTo(0, 0));
  await page.screenshot({ path: join(captures, 'page-disabled.png') });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: detail entry, image, host icons, themes, widths, English, return focus and disabled lifecycle',
  );
} finally {
  await app?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
