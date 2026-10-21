import { expectContactOption } from './contact-picker-actions.mjs';
import { prepareImportContact, openFileImport } from './file-import-navigation';
import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from './import-fixture';
import { selectMenu } from './app-fixture';

// 系统文件选择器由主 Agent 用 Computer Use 操作；默认不启动 App。
const enabled = process.env.NOTALONE_NATIVE_IMPORT_ONLY_ACCEPTANCE === '1';
const executable = process.env.NOTALONE_TEST_APP_EXECUTABLE;
test.skip(!enabled, '仅显式启用独立原生导入验收时执行');
if (enabled && (!executable || !path.isAbsolute(executable)
  || !/\.app\/Contents\/MacOS\/[^/]+$/.test(executable))) {
  throw new Error('原生导入验收必须指定最终 .app 内可执行文件的绝对路径：NOTALONE_TEST_APP_EXECUTABLE');
}
test.use({ appWorkingDirectory: '/' });

test('签名包通过真实系统文件选择器预览并完整导入六条合成资料后正常退出', async ({ runningApp: { app, appProcess, userData }, importBackend }) => {
  test.setTimeout(5 * 60_000);
  await writeFile(test.info().outputPath('native-import-only-owned.json'), JSON.stringify({
    pid: appProcess.pid, backendPid: importBackend.child.pid, userData,
    fixtureDirectory: importBackend.directory, filePath: importBackend.data.file_path,
    executable,
  }), { mode: 0o600, flag: 'wx' });

  const manager = await app.firstWindow();
  await expectContactOption(manager.getByRole('combobox', { name: '本次联系人', exact: true }), '合成联系人甲', { timeout: 20_000 });
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  await prepareImportContact(manager, '合成原生导入验收联系人', importBackend);
  await openFileImport(manager);
  console.log(`native_import_only_file: ${importBackend.data.file_path}`);
  await manager.getByRole('button', { name: '选择历史文件', exact: true }).click();
  console.log('native_import_only_stage: waiting-for-native-file-selection');
  await expect(manager.getByText('synthetic-import.jsonl', { exact: true })).toBeVisible({ timeout: 180_000 });

  await manager.getByRole('button', { name: '预览资料范围', exact: true }).click();
  await expect(manager.getByRole('region', { name: '单联系人资料预览' })).toContainText('6 条记录');
  console.log('native_import_only_stage: six-record-preview-confirmed');
  await manager.getByRole('checkbox', { name: '我已核对本人渠道身份、联系人和这份文件的资料范围' }).check();
  await manager.getByRole('button', { name: '确认本次预览', exact: true }).click();
  await manager.getByRole('button', { name: '正式导入这份资料', exact: true }).click();
  const progress = manager.getByRole('region', { name: '本次导入处理', exact: true });
  await expect(progress.getByText('新增 6 条消息，已存在 0 条消息。', { exact: true })).toBeVisible();
  await expect(progress.getByText('原任务全部步骤和最终核验已成功。', { exact: true })).toBeVisible({ timeout: 20_000 });
  console.log('native_import_only_stage: import-task-completed');

  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode).toBe(0);
  await writeFile(test.info().outputPath('native-import-only-results.json'), JSON.stringify({
    packaged: true, nativeDialogSelected: true, previewRecords: 6,
    importedMessages: 6, existingMessages: 0, importTaskCompleted: true,
    normalQuitExitZero: true, shortcutAcceptanceRecorded: false,
    wechatRead: false, externalModelCalls: 0,
  }), { mode: 0o600, flag: 'wx' });
  console.log('native_import_only_stage: normal-quit-completed');
});
