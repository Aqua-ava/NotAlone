import { expect } from '@playwright/test';
import { lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test as bindingTest } from './binding-fixture';
import { withBindingFixture } from './binding-backend-fixture';
import { selectMenu } from './app-fixture';
import { verifyAppTestLease } from './app-test-gate';
import { createAcceptanceCoordinator } from './acceptance-coordinator.mjs';

// 只在隔离验收中接入主Agent自有的固定原生探针包装器，不改变产品路径选择。
const test = bindingTest.extend({
  bindingBackend: async ({}, use) => {
    await verifyAppTestLease();
    const probe = process.env.NOTALONE_TEST_HEADER_CHANGE_WRAPPER;
    const executable = process.env.NOTALONE_TEST_APP_EXECUTABLE;
    if (!probe || !path.isAbsolute(probe) || !executable || !path.isAbsolute(executable)) {
      throw new Error('缺少本轮正式包及自有诊断包装器。');
    }
    const info = await lstat(probe);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()
      || (info.mode & 0o077) || !(info.mode & 0o100)) throw new Error('诊断包装器归属不明确。');
    await withBindingFixture('notalone-header-source-app-', 'single-account', async fixture => {
      const environment = fixture.environment.bind(fixture);
      fixture.environment = owner => ({ ...environment(owner), NOTALONE_SYNC_PROBE: probe });
      await fixture.setCli({ sessions: [], messages: {} });
      await fixture.startBackend();
      await use(fixture);
    });
  },
  launchConfiguration: async ({ bindingBackend }, use) => {
    await use({ pythonExecutable: bindingBackend.pythonExecutable, projectDirectory: path.resolve('..'),
      envFilePath: bindingBackend.envPath, backendInfoPath: bindingBackend.infoPath,
      syncProbePath: process.env.NOTALONE_TEST_HEADER_CHANGE_WRAPPER });
  },
});
test.skip(process.env.NOTALONE_HEADER_CHANGE_ACCEPTANCE !== '1', '仅主Agent协调的有限事件源诊断');
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('当前签名包在合成空授权范围运行有界事件源诊断后正常退出',
  async ({ runningApp: { app, appProcess }, bindingBackend }) => {
    const lease = await verifyAppTestLease();
    test.setTimeout(Math.max(1000, lease.until - Date.now() + 10_000));
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const directory = process.env.NOTALONE_AUTOMATIC_CONTROL_DIRECTORY;
    if (!directory || !path.isAbsolute(directory)) throw new Error('缺少本轮私有协调目录。');
    const coordinator = await createAcceptanceCoordinator({ directory, pid: appProcess.pid!,
      checkLease: verifyAppTestLease,
      isAlive: () => appProcess.exitCode === null && appProcess.signalCode === null });
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let normalQuit = false;
    try {
      const manager = await app.firstWindow();
      await manager.getByRole('button', { name: '同步设置', exact: true }).click();
      await manager.getByRole('button', { name: '开启后台同步', exact: true }).click();
      expect((await bindingBackend.request('/api/sync/status')).data.cli_bound_count).toBe(0);
      await selectMenu(app, '窗口', '输入小窗');
      await expect.poll(() => app.windows().some(page => page.url().endsWith('#helper'))).toBe(true);
      console.log('header_change_diagnostic_ready');
      expiry = setTimeout(() => { void coordinator.requestFinish().catch(() => {}); },
        Math.max(1, lease.until - Date.now() - 15_000));
      await coordinator.waitFor('finish');
      await coordinator.close();
      await selectMenu(app, 'NotAlone', '退出 NotAlone');
      await expect.poll(() => appProcess.exitCode, { timeout: 15_000 }).toBe(0);
      normalQuit = true;
    } finally {
      clearTimeout(expiry);
      await writeFile(test.info().outputPath('header-change-diagnostic-results.json'), JSON.stringify({
        diagnosticOnly: true, normalQuit, identityCertified: false, streamCoverageCertified: false,
        realCliRead: false, externalModelCalls: 0, externalMessagesSent: 0,
      }), { mode: 0o600 });
    }
  });
