import { expect, type ElectronApplication, type JSHandle } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, selectMenu } from './app-fixture';
import { shortcutAcceptanceMode } from './native-shortcut-feedback';
import { confirmShortcutFeedback } from './native-shortcut-coordination';
import { createAcceptanceCoordinator } from './acceptance-coordinator.mjs';
import { verifyAppTestLease } from './app-test-gate';
import { installNativeFocusDiagnostic, releaseNativeFocusDiagnostic } from './native-focus-diagnostic';

const diagnostic = process.env.NOTALONE_NATIVE_FOCUS_DIAGNOSTIC === '1';
const mode = diagnostic ? undefined : shortcutAcceptanceMode(process.env);
test.skip(!mode && !diagnostic, '只在主Agent的有限桌面验收时段执行');
// 空隔离启动配置不提供Python／项目，不启动后端、CLI或探针。
test.use({ launchConfiguration: {}, appWorkingDirectory: '/', trace: 'off', screenshot: 'off', video: 'off' });

test.beforeAll(async () => {
  if (!diagnostic) return;
  const executable = process.env.NOTALONE_TEST_APP_EXECUTABLE;
  if (!executable || !path.isAbsolute(executable)) throw new Error('诊断只接受精确v9签名包。');
  const asar = path.resolve(path.dirname(executable), '../Resources/app.asar');
  expect(createHash('sha256').update(await readFile(asar)).digest('hex'), '启动前核对冻结v9，不构建新包。')
    .toBe('e8ed699a551d8db5dfab5e4e1d652ae68bafe6e7d87a616876c739bb9a475021');
});

const shortcutTest = diagnostic ? test.skip : test;
shortcutTest('其他App在前台时只唤起同一小窗，第二次隐藏并保持管理后台隐藏', async ({ runningApp: { app, appProcess, userData } }) => {
  test.setTimeout(mode === 'human' ? 28 * 60_000 : 8 * 60_000);
  const until = mode === 'human' ? Date.now() + 25 * 60_000 : undefined;
  const manager = await app.firstWindow();
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
  await manager.getByRole('button', { name: '设置', exact: true }).click();
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

const diagnosticTest = diagnostic ? test : test.skip;
diagnosticTest('只读区分普通窗口隐藏与系统整体隐藏后的同包焦点', async ({ runningApp: { app, appProcess, userData } }) => {
  test.setTimeout(8 * 60_000);
  const lease = await verifyAppTestLease();
  const directory = process.env.NOTALONE_AUTOMATIC_CONTROL_DIRECTORY;
  if (!directory || !path.isAbsolute(directory)) throw new Error('缺少本轮私有协调目录。');
  const coordinator = await createAcceptanceCoordinator({ directory, pid: appProcess.pid!,
    checkLease: async () => {
      await verifyAppTestLease();
      if (Date.now() >= lease.until - 15_000) throw new Error('诊断结束，预留自有收尾。');
    }, isAlive: () => appProcess.exitCode === null && appProcess.signalCode === null });
  let observer: JSHandle<ReturnType<typeof installNativeFocusDiagnostic>> | undefined;
  let observations: ReturnType<ReturnType<typeof installNativeFocusDiagnostic>['snapshot']> | null = null;
  let observationUnavailable = false;
  let cleanupUnknown = false;
  let normalQuit = false;
  const actionSignals: { stage: string; receivedAtMs: number }[] = [];
  const persistObservations = () => writeFile(test.info().outputPath('native-focus-diagnostic-observations.json'),
    JSON.stringify(observations), { mode: 0o600 });
  const closeObserver = async (attempts: 1 | 2) => {
    if (!observer) return true;
    const current = observer;
    const result = await releaseNativeFocusDiagnostic(() => current.evaluate(probe => probe.dispose()),
      () => current.dispose(), lease.until - 5_000, attempts);
    if (result.snapshot) observations = result.snapshot;
    observationUnavailable ||= result.unavailable;
    cleanupUnknown ||= result.unknown;
    if (result.released) observer = undefined;
    return result.released;
  };
  try {
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const manager = await app.firstWindow();
    await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
    // Root负责全部GUI；先实际从公开菜单创建helper，再开始两个条件的只读采样。
    await coordinator.waitFor('setup-helper-created');
    await expect.poll(() => app.windows().some(page => page.url().endsWith('#helper'))).toBe(true);
    const helper = app.windows().find(page => page.url().endsWith('#helper'))!;
    const managerId = await (await app.browserWindow(manager)).evaluate(window => window.id);
    const helperId = await (await app.browserWindow(helper)).evaluate(window => window.id);
    await writeFile(test.info().outputPath('native-focus-diagnostic-owned.json'), JSON.stringify({
      appPid: appProcess.pid, userData, managerId, helperId, backendConfigured: false,
    }), { mode: 0o600, flag: 'wx' });
    observer = await app.evaluateHandle(installNativeFocusDiagnostic, { managerId, helperId });
    for (const condition of ['ordinary-hide-open', 'system-hide-open'] as const) {
      await observer.evaluate((probe, next) => probe.setStage(next), condition);
      console.log(`native_focus_diagnostic_stage: ${condition}；只读采样已开始，请Root操作并在最后动作约3秒后发信号。`);
      await coordinator.waitFor(`${condition}-done`);
      actionSignals.push({ stage: condition, receivedAtMs: Date.now() });
      observations = await observer.evaluate(probe => probe.snapshot());
      await persistObservations();
    }
    await observer.evaluate(probe => probe.setStage('quit'));
    expect(await closeObserver(2), '自有监听清理未确认，保留handle至finally有限重试。').toBe(true);
    await persistObservations();
    console.log('native_focus_diagnostic_stage: quit；采样已结束并保存清理状态，请Root发quit信号后实际点击公开菜单退出。');
    await coordinator.waitFor('quit');
    await expect.poll(() => appProcess.exitCode, { timeout: Math.max(1, Math.min(45_000, lease.until - Date.now() - 5_000)) }).toBe(0);
    normalQuit = true;
  } finally {
    if (observer) {
      try { await closeObserver(1); }
      catch { observationUnavailable = true; }
    }
    await coordinator.close();
    await persistObservations();
    await writeFile(test.info().outputPath('native-focus-diagnostic-results.json'), JSON.stringify({
      actionSignals, normalQuit, observationUnavailable,
      observationUnknown: cleanupUnknown || observationUnavailable || !observations || observations.unknown,
      cleanupComplete: observations?.cleanupComplete ?? null,
      actionSignalsCertifyFocus: false, focusCertified: false, guiActionsPerformedByRunner: false,
      backendConfigured: false, wechatRead: false, cliInvocations: 0, visualCaptures: 0,
      externalModelCalls: 0, externalMessagesSent: 0,
    }), { mode: 0o600 });
  }
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
