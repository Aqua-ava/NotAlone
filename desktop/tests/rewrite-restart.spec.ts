import { expect, type ElectronApplication } from '@playwright/test';
import { isolatedAppEnvironment, selectMenu } from './app-fixture';
import { launchApp } from './app-test-gate';
import { test } from './rewrite-fixture';

test('同一 userData 正常退出再启动不恢复草稿、编辑和当次语气', async ({ runningApp: { app, appProcess, userData }, appDirectory, rewriteBackend }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
  const helper = await opened;
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('退出后不恢复的草稿。');
  await helper.getByRole('combobox', { name: '本次语气', exact: true }).selectOption('polite');
  await helper.getByRole('textbox', { name: '本次要求', exact: true }).fill('本次临时要求');
  await rewriteBackend.plan({ count: 1 });
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).fill('退出后不恢复的编辑。');
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
    await expect(nextManager.getByText('本次联系人：未确认', { exact: true })).toBeVisible();
    await nextManager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    const nextOpened = restarted.waitForEvent('window');
    await nextManager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
    const nextHelper = await nextOpened;
    await expect(nextHelper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('');
    await expect(nextHelper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
    await expect(nextHelper.getByRole('textbox', { name: '本次要求', exact: true })).toHaveValue('');
    await expect(nextHelper.getByRole('combobox', { name: '本次语气', exact: true })).toHaveValue('original');
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
    await selectMenu(restarted, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => restartedProcess.exitCode).toBe(0);
  } finally { await restarted?.close().catch(() => {}); }
});
