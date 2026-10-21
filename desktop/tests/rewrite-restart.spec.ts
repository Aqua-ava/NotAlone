import { expect, type ElectronApplication } from '@playwright/test';
import { isolatedAppEnvironment, selectMenu } from './app-fixture';
import { launchApp } from './app-test-gate';
import { test } from './rewrite-fixture';
import { prepareTransientRewrite, assertWorkspaceRecovery } from './rewrite-page-scenarios';

test('同一 userData 正常退出再启动不恢复草稿、编辑和当次语气', async ({ runningApp: { app, appProcess, userData }, appDirectory, rewriteBackend }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption({ label: '合成联系人甲' });
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
  const helper = await opened;
  await prepareTransientRewrite(helper, rewriteBackend);
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode).toBe(0);
  await rewriteBackend.command('restart');
  let restarted: ElectronApplication | undefined;
  try {
    restarted = await launchApp({ executablePath: process.env.NOTALONE_TEST_APP_EXECUTABLE,
      args: [...(process.env.NOTALONE_TEST_APP_EXECUTABLE ? [] : [appDirectory]), `--user-data-dir=${userData}`],
      env: isolatedAppEnvironment(userData, rewriteBackend.environment()) });
    const restartedProcess = restarted.process();
    const nextManager = await restarted.firstWindow();
    await expect(nextManager.getByRole('combobox', { name: '本次联系人', exact: true })).toHaveValue('');
    await nextManager.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption({ label: '合成联系人甲' });
    const nextOpened = restarted.waitForEvent('window');
    await nextManager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
    const nextHelper = await nextOpened;
    await assertWorkspaceRecovery(nextHelper);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
    await selectMenu(restarted, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => restartedProcess.exitCode).toBe(0);
  } finally { await restarted?.close().catch(() => {}); }
});
