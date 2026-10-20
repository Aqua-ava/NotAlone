import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './app-test-gate';
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, selectMenu, isolatedAppEnvironment } from './app-fixture';

test('设置显示默认全局快捷键的真实注册结果', async ({ runningApp: { app } }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '设置', exact: true }).click();
  const controls = manager.getByRole('region', { name: '桌面操作' });
  await expect(controls.getByRole('textbox', { name: '小窗快捷键' })).toHaveValue('Command+Shift+Space');
  await expect(controls.getByRole('status')).toHaveText('已注册 Command+Shift+Space');
  // 辅助检查 OS 注册状态；实际系统按键另行实机验收，不直接调用快捷键回调。
  expect(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Command+Shift+Space'))).toBe(true);
});

// 系统边界故障夹具：在真实 App ready 前安排按键占用，然后加载未经替换的构建入口。
// macOS 可允许两个进程非独占注册同键；同进程重复注册才稳定返回 false。
const conflictTest = test.extend({
  appDirectory: async ({}, use) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'notalone-shortcut-conflict-'));
    try {
      await cp(path.resolve('dist'), path.join(directory, 'dist'), { recursive: true });
      await writeFile(path.join(directory, 'package.json'), JSON.stringify({ main: 'shortcut-fixture.cjs' }));
      await writeFile(path.join(directory, 'shortcut-fixture.cjs'), `const { app, globalShortcut } = require('electron');
app.whenReady().then(() => {
  globalShortcut.register('Command+Shift+Space', () => {});
  globalShortcut.register('Command+Shift+L', () => {});
});
require('./dist/main/index.cjs');`);
      await use(directory);
    } finally { await rm(directory, { recursive: true, force: true }); }
  },
});

conflictTest('默认快捷键冲突在首屏可见，换键可恢复，修改失败保留旧键', async ({ runningApp: { app } }) => {
  test.skip(Boolean(process.env.NOTALONE_TEST_APP_EXECUTABLE), '占用场景只包装隔离构建入口，不修改签名包');
  const manager = await app.firstWindow();
  await expect(manager.getByText('快捷键未启用，请在设置中换一个组合。', { exact: true })).toBeVisible();
  await manager.getByRole('button', { name: '设置', exact: true }).click();
  const controls = manager.getByRole('region', { name: '桌面操作' });
  await expect(controls.getByRole('status')).toHaveText('快捷键未启用，请在设置中换一个组合。');
  await controls.getByRole('textbox', { name: '小窗快捷键' }).fill('Command+Shift+K');
  await controls.getByRole('button', { name: '保存快捷键' }).click();
  await expect(controls.getByRole('status')).toHaveText('已注册 Command+Shift+K');
  await controls.getByRole('textbox', { name: '小窗快捷键' }).fill('Command+Shift+L');
  await controls.getByRole('button', { name: '保存快捷键' }).click();
  await expect(controls.getByRole('alert')).toHaveText('该快捷键未能注册，可能已被占用。原快捷键与设置保持不变。');
  await expect(controls.getByRole('status')).toHaveText('已注册 Command+Shift+K');
  expect(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Command+Shift+K'))).toBe(true);
  await manager.screenshot({ path: test.info().outputPath('shortcut-conflict.png') });
});

test('用户可以修改快捷键并在重启后继续使用已保存的组合', async ({ runningApp: { app, appProcess }, appDirectory }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '设置', exact: true }).click();
  const controls = manager.getByRole('region', { name: '桌面操作' });
  await controls.getByRole('textbox', { name: '小窗快捷键' }).fill('Command+Shift+K');
  await controls.getByRole('button', { name: '保存快捷键' }).click();
  await expect(controls.getByRole('status')).toHaveText('已注册 Command+Shift+K');
  expect(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Command+Shift+K'))).toBe(true);
  expect(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Command+Shift+Space'))).toBe(false);

  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode).toBe(0);
  const restarted = await launchApp({
    executablePath: process.env.NOTALONE_TEST_APP_EXECUTABLE,
    args: [...(process.env.NOTALONE_TEST_APP_EXECUTABLE ? [] : [appDirectory]), `--user-data-dir=${userData}`],
    env: isolatedAppEnvironment(userData),
  });
  try {
    const reopened = await restarted.firstWindow();
    await reopened.getByRole('button', { name: '设置', exact: true }).click();
    await expect(reopened.getByRole('region', { name: '桌面操作' }).getByRole('status')).toHaveText('已注册 Command+Shift+K');
  } finally { await restarted.close(); }
});

test('保存失败仍保留可用旧键和安全错误，恢复文件后可再次修改', async ({ runningApp: { app } }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '设置', exact: true }).click();
  const controls = manager.getByRole('region', { name: '桌面操作' });
  await controls.getByRole('textbox', { name: '小窗快捷键' }).fill('Command+Shift+K');
  await controls.getByRole('button', { name: '保存快捷键' }).click();
  await expect(controls.getByRole('status')).toHaveText('已注册 Command+Shift+K');
  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  const file = path.join(userData, 'desktop-settings.json');
  await rename(file, `${file}.saved`);
  await mkdir(file);
  try {
    await controls.getByRole('textbox', { name: '小窗快捷键' }).fill('Command+Shift+J');
    await controls.getByRole('button', { name: '保存快捷键' }).click();
    await expect(controls.getByRole('alert')).toHaveText('快捷键设置未能保存，原快捷键与设置保持不变。');
    await expect(controls.getByRole('status')).toHaveText('已注册 Command+Shift+K');
    expect(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Command+Shift+K'))).toBe(true);
    expect(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Command+Shift+J'))).toBe(false);
    await expect(controls).not.toContainText(userData);
  } finally {
    await rm(file, { recursive: true });
    await rename(`${file}.saved`, file);
  }
  await controls.getByRole('button', { name: '保存快捷键' }).click();
  await expect(controls.getByRole('status')).toHaveText('已注册 Command+Shift+J');
});

test('正文区域的置顶按钮可点击，隐藏恢复保留置顶且不会重复窗口，后台可独立打开', async ({ runningApp: { app } }) => {
  const manager = await app.firstWindow();
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗' }).click();
  const helper = await opened;
  const pin = helper.getByRole('button', { name: '置顶输入小窗', exact: true });
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => pinned(app, helper)).toBe(true);
  await helper.getByRole('button', { name: '隐藏输入小窗' }).click();
  await expect.poll(() => visible(app, helper)).toBe(false);
  for (let attempt = 0; attempt < 3; attempt++) {
    await manager.getByRole('button', { name: '打开输入小窗' }).click();
  }
  await expect.poll(() => visible(app, helper)).toBe(true);
  await expect.poll(() => app.windows().length).toBe(2);
  await expect.poll(() => pinned(app, helper)).toBe(true);
  await (await app.browserWindow(manager)).evaluate((window) => window.close());
  await expect.poll(() => visible(app, manager)).toBe(false);
  await helper.getByRole('button', { name: '打开管理后台' }).click();
  await expect.poll(() => visible(app, manager)).toBe(true);
  expect(await pinned(app, manager)).toBe(false);
  await pin.click();
  await expect.poll(() => pinned(app, helper)).toBe(false);
  await helper.screenshot({ path: test.info().outputPath('helper-desktop-controls.png') });
});

test('非法快捷键不会覆盖已注册组合，退出会注销本轮快捷键', async ({ runningApp: { app, appProcess } }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '设置', exact: true }).click();
  const controls = manager.getByRole('region', { name: '桌面操作' });
  await controls.getByRole('textbox', { name: '小窗快捷键' }).fill('Space');
  await controls.getByRole('button', { name: '保存快捷键' }).click();
  await expect(controls.getByRole('alert')).toHaveText('快捷键格式无效。请使用 Command、Control 或 Alt 加一个按键。');
  await expect(controls.getByRole('status')).toHaveText('已注册 Command+Shift+Space');

  // 只观察 Electron 的公开生命周期和系统注册状态，不调用产品内部清理函数。
  let released: boolean | undefined;
  const observe = (chunk: Buffer) => {
    const match = chunk.toString().match(/notalone-shortcut-release:(true|false)/);
    if (match) released = match[1] === 'false';
  };
  appProcess.stdout!.on('data', observe);
  try {
    await app.evaluate(({ app, globalShortcut }) => {
      app.once('will-quit', () => {
        process.stdout.write(`notalone-shortcut-release:${globalShortcut.isRegistered('Command+Shift+Space')}\n`);
      });
    });
    await selectMenu(app, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => appProcess.exitCode).toBe(0);
    await expect.poll(() => released).toBe(true);
  } finally { appProcess.stdout!.removeListener('data', observe); }
});

async function visible(app: ElectronApplication, page: Page): Promise<boolean> {
  return (await app.browserWindow(page)).evaluate((window) => window.isVisible());
}

async function pinned(app: ElectronApplication, page: Page): Promise<boolean> {
  return (await app.browserWindow(page)).evaluate((window) => window.isAlwaysOnTop());
}
