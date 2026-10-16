import { expect, type ElectronApplication } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { test, selectMenu } from './app-fixture';
import { shortcutAcceptanceMode } from './native-shortcut-feedback';
import { confirmShortcutFeedback } from './native-shortcut-coordination';

const mode = shortcutAcceptanceMode(process.env);
test.skip(!mode, '只在主Agent的有限桌面验收时段执行');
// 空隔离启动配置不提供Python／项目，不启动后端、CLI或探针。
test.use({ launchConfiguration: {}, appWorkingDirectory: '/' });

test('其他App在前台时只唤起同一小窗，第二次隐藏并保持管理后台隐藏', async ({ runningApp: { app, appProcess, userData } }) => {
  test.setTimeout(mode === 'human' ? 28 * 60_000 : 8 * 60_000);
  const until = mode === 'human' ? Date.now() + 25 * 60_000 : undefined;
  const manager = await app.firstWindow();
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
  await manager.getByRole('button', { name: '应用配置', exact: true }).click();
  const controls = manager.getByRole('region', { name: '桌面操作' });
  await controls.getByRole('textbox', { name: '小窗快捷键' }).fill('Command+Shift+Y');
  await controls.getByRole('button', { name: '保存快捷键' }).click();
  await expect(controls.getByRole('status')).toHaveText('已注册 Command+Shift+Y');
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
  const helper = await opened;
  const managerWindow = await app.browserWindow(manager);
  const helperWindow = await app.browserWindow(helper);
  const managerId = await managerWindow.evaluate((window) => window.id);
  const helperId = await helperWindow.evaluate((window) => window.id);
  await helper.getByRole('button', { name: '隐藏输入小窗', exact: true }).click();
  await managerWindow.evaluate((window) => window.close());
  await expect.poll(() => windowState(app)).toEqual([
    { id: managerId, visible: false, focused: false },
    { id: helperId, visible: false, focused: false },
  ]);
  await writeFile(test.info().outputPath('focus-owned.json'), JSON.stringify({
    pid: appProcess.pid, userData, managerId, helperId, backendConfigured: false,
    defaultUserDataUsed: false,
  }), { mode: 0o600, flag: 'wx' });

  console.log('focus_acceptance_stage: 管理后台和小窗均已隐藏，请主Agent将空白Finder窗口置于前台。');
  await confirmShortcutFeedback('external-focus', 'agent', async (timeout) => {
    await expect.poll(() => windowState(app), { timeout }).toEqual([
      { id: managerId, visible: false, focused: false },
      { id: helperId, visible: false, focused: false },
    ]);
  }, until);
  await recordState(app, 'before-show');
  console.log('focus_acceptance_stage: 保持其他App前台，请实际按一次Command+Shift+Y；显示后先不要再次按。');
  await confirmShortcutFeedback('show', mode!, async (timeout) => {
    await expect.poll(() => windowState(app), { timeout }).toEqual([
      { id: managerId, visible: false, focused: false },
      { id: helperId, visible: true, focused: true },
    ]);
    await recordState(app, 'shown');
  }, until);
  // show 收据等待期间可能已被其他操作隐藏；旧 hidden 不能成为第二次按键的通过证据。
  const hideBaseline = await windowState(app);
  expect(hideBaseline, '发出隐藏请求前，同一小窗必须仍显示；已隐藏时立即失败。').toEqual([
    { id: managerId, visible: false, focused: false },
    expect.objectContaining({ id: helperId, visible: true }),
  ]);
  await recordState(app, 'before-hide', hideBaseline);
  console.log('focus_acceptance_stage: 现在请再次实际按Command+Shift+Y，只核对同一小窗消失，管理后台没有出现。');
  await confirmShortcutFeedback('hide', mode!, async (timeout) => {
    await expect.poll(() => windowState(app), { timeout }).toEqual([
      { id: managerId, visible: false, focused: false },
      { id: helperId, visible: false, focused: false },
    ]);
    await recordState(app, 'hidden');
  }, until);
  expect(app.windows()).toHaveLength(2);
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode).toBe(0);
  await writeFile(test.info().outputPath('focus-results.json'), JSON.stringify({
    packaged: true, managerInitiallyHidden: true, helperShownAndFocused: true,
    sameHelperHidden: true, managerRemainedHidden: true, noNotAloneWindowFocusedAfterHide: true,
    externalAppForegroundRecordedByAgent: true, externalAppFocusRestoredCertified: false,
    humanShortcutAcceptanceRecorded: mode === 'human', agentShortcutAcceptanceRecorded: mode === 'agent',
    normalQuitExitZero: true, backendConfigured: false, wechatRead: false, externalModelCalls: 0,
  }), { mode: 0o600, flag: 'wx' });
});

async function windowState(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({
    id: window.id, visible: window.isVisible(), focused: window.isFocused(),
  })).sort((a, b) => a.id - b.id));
}

async function recordState(app: ElectronApplication, stage: string,
  windows?: Awaited<ReturnType<typeof windowState>>) {
  await writeFile(test.info().outputPath(`focus-${stage}-observed.json`), JSON.stringify({
    stage, observedAt: Date.now(), windows: windows ?? await windowState(app), userConfirmationRecorded: false,
  }), { mode: 0o600, flag: 'wx' });
}
