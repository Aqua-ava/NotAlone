import { expect } from '@playwright/test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, selectMenu } from './app-fixture';

test.skip(process.env.NOTALONE_FOREGROUND_CALIBRATION_ACCEPTANCE !== '1', '须由主协调者安排有限现场时段');
test.use({ appEnvironment: { NOTALONE_SYNC_PROBE: path.resolve('../native/macos/build/cli/notalone-sync-probe') } });
// 只经真实 App 的公开菜单等待用户框选；不替换系统输入或采集微信画面。
test('用户框选最小定位区域后保存无图像的待校验布局', async ({ runningApp }) => {
  test.setTimeout(420_000);
  const { app, appProcess, userData } = runningApp;
  const manager = await app.firstWindow();
  await manager.waitForURL('notalone://app/index.html#manager');
  await writeFile(test.info().outputPath('owned-app.json'), JSON.stringify({ pid: appProcess.pid, userData }), { mode: 0o600 });
  const selectionPath = path.join(userData, 'foreground-layout-selection.json');
  process.stdout.write('foreground_calibration_human_step: 请手工打开无私人资料的微信测试会话；按校准框内说明选区，最后按回车确认。\n');
  await selectMenu(app, '窗口', '校准微信最小定位区域…');
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(selectionPath, 'utf8')); }
    catch { return null; }
  }, { timeout: 380_000 }).not.toBeNull();
  const selection = JSON.parse(await readFile(selectionPath, 'utf8')) as Record<string, unknown>;
  expect(Object.keys(selection).sort()).toEqual(['processId', 'regions', 'schemaVersion', 'state', 'wechatBuild', 'wechatVersion', 'windowFrame', 'windowId'].sort());
  expect(selection.schemaVersion).toBe(1);
  expect(selection.state).toBe('selected-awaiting-verification');
  expect(selection.wechatVersion).toBe('4.0.6');
  expect(selection.wechatBuild).toBe('29387');
  expect(Object.keys(selection.regions as object).sort()).toEqual(['displayName', 'selectedRowName', 'verticalDivider', 'headerDivider', 'selectedHighlight'].sort());
  expect((await stat(selectionPath)).mode & 0o777).toBe(0o600);
  await writeFile(test.info().outputPath('pending-layout-selection.json'), JSON.stringify(selection), { mode: 0o600 });
  // 选区完成不代表采集、OCR质量或自动绑定通过。
  process.stdout.write('foreground_calibration_selection_saved: 仅几何、版本和窗口标识；未采集图像，session门禁仍关闭。\n');
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode, { timeout: 20_000 }).toBe(0);
});
