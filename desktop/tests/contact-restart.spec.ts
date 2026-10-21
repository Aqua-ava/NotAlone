import { expect, type ElectronApplication } from '@playwright/test';
import { launchApp } from './app-test-gate';
import type { ChildProcess } from 'node:child_process';
import { test } from './contact-fixture';
import { isolatedAppEnvironment, selectMenu } from './app-fixture';

test('同一 userData 正常退出再启动时，不恢复联系人选择或未提交草稿', async ({ runningApp: { app, appProcess, userData }, appDirectory, appEnvironment, contactBackend }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption({ label: '合成联系人甲' });
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗' }).click();
  const helper = await opened;
  await helper.getByRole('textbox', { name: '草稿' }).fill('未提交草稿不跨重启保存。');
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode).toBe(0);
  let restarted: ElectronApplication | undefined;
  let restartedProcess: ChildProcess | undefined;
  try {
    restarted = await launchApp({ executablePath: process.env.NOTALONE_TEST_APP_EXECUTABLE,
      args: [...(process.env.NOTALONE_TEST_APP_EXECUTABLE ? [] : [appDirectory]), `--user-data-dir=${userData}`],
      env: isolatedAppEnvironment(userData, appEnvironment) });
    restartedProcess = restarted.process();
    const restoredManager = await restarted.firstWindow();
    await expect(restoredManager.getByRole('combobox', { name: '本次联系人', exact: true }).getByRole('option', { name: '合成联系人甲', exact: true })).toHaveCount(1, { timeout: 15_000 });
    await expect(restoredManager.getByRole('combobox', { name: '本次联系人', exact: true })).toHaveValue('');
    const reopened = restarted.waitForEvent('window');
    await restoredManager.getByRole('button', { name: '打开输入小窗' }).click();
    const restoredHelper = await reopened;
    await expect(restoredHelper.getByRole('textbox', { name: '草稿' })).toHaveValue('');
    await restoredHelper.getByRole('combobox', { name: '本次联系人' }).selectOption(contactBackend.data.contact_ids[0]);
    await expect(restoredHelper.getByRole('textbox', { name: '草稿' })).toBeEnabled();
    await expect(restoredHelper.getByRole('textbox', { name: '草稿' })).toHaveValue('');
    await selectMenu(restarted, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => restartedProcess!.exitCode).toBe(0);
  } finally {
    if (restarted && restartedProcess?.exitCode === null && restartedProcess.signalCode === null) {
      const child = restartedProcess;
      const fallback = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000);
      try { await restarted.close().catch(() => {}); } finally { clearTimeout(fallback); }
    }
  }
});
