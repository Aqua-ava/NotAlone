import { expect } from '@playwright/test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, selectMenu } from './app-fixture';

test.skip(process.env.NOTALONE_FOREGROUND_LAYOUT_ACCEPTANCE !== '1', '须由主协调者安排有限的最小区域采集现场轮次');
// 签名包清除隔离占位值，沿生产Resources完整性接线；开发验收指定仓库探针。
test.use({ appEnvironment: process.env.NOTALONE_TEST_APP_EXECUTABLE ? { NOTALONE_SYNC_PROBE: '' }
  : { NOTALONE_SYNC_PROBE: path.resolve('../native/macos/build/cli/notalone-sync-probe') } });

// 五处几何仍经公开表单输入；不预造verified文件或替换原生捕获、权限与OCR。
test('公开校准后只以五处最小区域验证当前布局', async ({ runningApp }) => {
  test.setTimeout(420_000);
  const { app, appProcess, userData } = runningApp;
  const manager = await app.firstWindow();
  await manager.waitForURL('notalone://app/index.html#manager');
  await writeFile(test.info().outputPath('owned-app.json'), JSON.stringify({ pid: appProcess.pid, userData }), { mode: 0o600 });
  await selectMenu(app, '窗口', '校准微信最小定位区域…');
  const selectionPath = path.join(userData, 'foreground-layout-selection.json');
  const profilePath = path.join(userData, 'foreground-layout-profile.json');
  const resultPath = path.join(userData, 'foreground-layout-verification.json');
  const progressPath = path.join(userData, 'foreground-layout-verification-progress.json');
  const selectionOutcome = async () => {
    try { return JSON.parse(await readFile(selectionPath, 'utf8')).state; } catch { /* 等待公开选择结果。 */ }
    try {
      const result = JSON.parse(await readFile(resultPath, 'utf8'));
      if (result.state === 'failed') {
        await writeFile(test.info().outputPath('layout-selection-failure.json'), JSON.stringify(result), { mode: 0o600 });
        return `failed:${result.error}`;
      }
    } catch { /* 等待公开失败结果。 */ }
    return null;
  };
  await expect.poll(selectionOutcome, { timeout: 180_000 }).not.toBeNull();
  expect(await selectionOutcome()).toBe('selected-awaiting-verification');
  expect(JSON.parse(await readFile(selectionPath, 'utf8')).state).toBe('selected-awaiting-verification');
  await writeFile(test.info().outputPath('pending-layout-selection.json'), await readFile(selectionPath), { mode: 0o600 });
  // 操作者关闭公开结果说明后再选择下一菜单，不读取或操纵内部flight状态。
  process.stdout.write('foreground_layout_operator_step: 五处几何已保存，请关闭结果说明后从窗口菜单校验，并由获认可操作者切回当前微信。\n');
  try {
    // 原生固定阶段或宿主终态失败后才给结果预算；host不证明原生已进入。
    await expect.poll(async () => {
      try { if (JSON.parse(await readFile(resultPath, 'utf8')).state === 'failed') return true; } catch { /* 等待真实结果。 */ }
      try { return ['selection', 'context', 'capture-setup', 'sentinels-before', 'names', 'sentinels-after', 'profile']
        .includes(JSON.parse(await readFile(progressPath, 'utf8')).stage); } catch { return false; }
    }, { timeout: 120_000 }).toBe(true);
    await expect.poll(async () => { try { return JSON.parse(await readFile(resultPath, 'utf8')); } catch { return null; } }, { timeout: 100_000 }).not.toBeNull();
    const verification = JSON.parse(await readFile(resultPath, 'utf8')) as Record<string, unknown>;
    await writeFile(test.info().outputPath('layout-verification-result.json'), JSON.stringify(verification), { mode: 0o600 });
    expect(verification.state, `校验阶段=${verification.stage}；安全错误码=${verification.error}`).toBe('verified');
    expect((await stat(resultPath)).mode & 0o777).toBe(0o600);
    const profile = JSON.parse(await readFile(profilePath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(profile).sort()).toEqual(['schemaVersion', 'state', 'wechatVersion', 'wechatBuild', 'processId', 'windowId', 'windowFrame', 'regions', 'pixelScale', 'sentinelDigests'].sort());
    expect(profile.state).toBe('verified-minimal-layout');
    expect(Object.keys(profile.regions as object)).toHaveLength(5);
    expect(Object.keys(profile.sentinelDigests as object).sort()).toEqual(['headerDivider', 'selectedHighlight', 'verticalDivider']);
    for (const digest of Object.values(profile.sentinelDigests as object)) expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(profilePath)).mode & 0o777).toBe(0o600);
    await writeFile(test.info().outputPath('verified-layout-profile.json'), JSON.stringify(profile), { mode: 0o600 });
    process.stdout.write('foreground_layout_verified: 本轮原生五处采集、同名质量与细条复核已形成无图像profile；不代表绑定和自动定位通过。\n');
    await selectMenu(app, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => appProcess.exitCode, { timeout: 20_000 }).toBe(0);
  } finally {
    try {
      const progress = JSON.parse(await readFile(progressPath, 'utf8'));
      if (progress.state === 'running' && ['host', 'selection', 'context', 'capture-setup', 'sentinels-before', 'names', 'sentinels-after', 'profile'].includes(progress.stage)) {
        await writeFile(test.info().outputPath('layout-verification-progress.json'), JSON.stringify({ state: 'running', stage: progress.stage }), { mode: 0o600 });
      }
    } catch { /* 没有阶段文件时保留原失败，不编造进度。 */ }
  }
});
