import { expect, type Page } from '@playwright/test';
import { cp, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test as appTest, selectMenu } from './app-fixture';

// 只损坏隔离副本的随包资源，既不修改正式 .app，也不替换应用内部实现。
const test = appTest.extend({
  appDirectory: async ({}, use) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'notalone-resource-'));
    try {
      await cp(path.resolve('dist'), path.join(directory, 'dist'), { recursive: true });
      await writeFile(path.join(directory, 'package.json'), JSON.stringify({ main: 'dist/main/index.cjs' }));
      await rename(path.join(directory, 'dist/renderer/index.html'), path.join(directory, 'index.html.saved'));
      await use(directory);
    } finally { await rm(directory, { recursive: true, force: true }); }
  },
});

// 正式签名包不允许修改；故障场景使用真实 Electron 运行隔离的构建副本。
test.skip(Boolean(process.env.NOTALONE_TEST_APP_EXECUTABLE), '此场景只修改隔离构建副本，不损坏签名包');

test('资源缺失时显示安全中文说明，修复资源后可从公开菜单重新打开', async ({ runningApp: { app }, appDirectory }) => {
  let failedWindow: Page | undefined;
  await expect.poll(async () => {
    for (const window of app.windows()) {
      if (await window.getByRole('heading', { name: '窗口暂时无法打开' }).isVisible()) {
        failedWindow = window;
        return true;
      }
    }
    return false;
  }).toBe(true);
  await expect(failedWindow!.getByText('请从“窗口”菜单重试。', { exact: true })).toBeVisible();
  await expect(failedWindow!.locator('body')).not.toContainText(appDirectory);
  await failedWindow!.screenshot({ path: test.info().outputPath('window-error.png') });
  await rename(path.join(appDirectory, 'index.html.saved'), path.join(appDirectory, 'dist/renderer/index.html'));
  const reopened = app.waitForEvent('window');
  await selectMenu(app, '窗口', '管理后台');
  const manager = await reopened;
  await expect(manager.getByRole('heading', { name: '联系人与绑定' })).toBeVisible();
  await expect.poll(() => failedWindow!.isClosed()).toBe(true);
});
