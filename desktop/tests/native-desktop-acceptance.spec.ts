import { expect } from '@playwright/test';
import { constants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { test } from './import-fixture';
import { selectMenu } from './app-fixture';
import { verifyAppTestLease } from './app-test-gate';

// 真实文件选择和系统按键由现场操作；默认套件不启动此人工验收。
test.skip(process.env.NOTALONE_NATIVE_DESKTOP_ACCEPTANCE !== '1', '只在主 Agent 的有限现场预约中执行');

test('签名包使用真实文件选择器导入合成资料，系统快捷键唤起和隐藏同一小窗', async ({ runningApp: { app, appProcess, userData }, importBackend }) => {
  test.setTimeout(8 * 60_000);
  const manager = await app.firstWindow();
  await expect(manager.getByRole('button', { name: '选择合成联系人甲', exact: true })).toBeVisible({ timeout: 20_000 });
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  await writeFile(test.info().outputPath('owned-app.json'), JSON.stringify({
    pid: appProcess.pid, userData, databaseName: importBackend.data.database_name,
    fixtureDirectory: importBackend.directory, filePath: importBackend.data.file_path,
  }), { mode: 0o600 });

  await manager.getByRole('button', { name: '历史导入', exact: true }).click();
  console.log(`native_acceptance_file: ${importBackend.data.file_path}`);
  await manager.getByRole('button', { name: '选择历史文件', exact: true }).click();
  console.log('native_acceptance_stage: 等待真实系统文件选择器选择本轮合成文件。');
  await expect(manager.getByText('synthetic-import.jsonl', { exact: true })).toBeVisible({ timeout: 180_000 });
  await manager.getByRole('combobox', { name: '资料归属联系人' }).selectOption('new');
  await manager.getByRole('textbox', { name: '新联系人名称' }).fill('合成原生验收联系人');
  await manager.getByRole('button', { name: '预览资料范围', exact: true }).click();
  await expect(manager.getByRole('region', { name: '单联系人资料预览' })).toContainText('6 条记录');
  await manager.getByRole('checkbox', { name: '我已核对本人渠道身份、联系人和这份文件的资料范围' }).check();
  await manager.getByRole('button', { name: '确认本次预览', exact: true }).click();
  await manager.getByRole('button', { name: '正式导入这份资料', exact: true }).click();
  const progress = manager.getByRole('region', { name: '本次导入处理', exact: true });
  await expect(progress.getByText('新增 6 条消息，已存在 0 条消息。', { exact: true })).toBeVisible();
  await expect(progress.getByText('原任务全部步骤和最终核验已成功。', { exact: true })).toBeVisible({ timeout: 20_000 });

  await manager.getByRole('button', { name: '应用配置', exact: true }).click();
  const controls = manager.getByRole('region', { name: '桌面操作' });
  await controls.getByRole('textbox', { name: '小窗快捷键' }).fill('Command+Shift+Y');
  await controls.getByRole('button', { name: '保存快捷键' }).click();
  await expect(controls.getByRole('status')).toHaveText('已注册 Command+Shift+Y');
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
  const helper = await opened;
  const helperWindow = await app.browserWindow(helper);
  await helper.getByRole('button', { name: '隐藏输入小窗', exact: true }).click();
  await expect.poll(() => helperWindow.evaluate((window) => window.isVisible())).toBe(false);
  console.log('native_acceptance_stage: 请实际按 Command+Shift+Y，唤起输入小窗。');
  await expect.poll(() => helperWindow.evaluate((window) => window.isVisible()), { timeout: 180_000 }).toBe(true);
  await confirmHumanShortcutFeedback('show');
  console.log('native_acceptance_stage: 请再次实际按 Command+Shift+Y，隐藏同一输入小窗；收到你的明确确认后本轮测试才正常退出 App，退出后快捷键不再可用。');
  await expect.poll(() => helperWindow.evaluate((window) => window.isVisible()), { timeout: 180_000 }).toBe(false);
  await confirmHumanShortcutFeedback('hide');
  expect(app.windows()).toHaveLength(2);
  await writeFile(test.info().outputPath('native-results.json'), JSON.stringify({
    packaged: true, nativeDialogSelected: true, importedMessages: 6,
    importStepsCompleted: true, helperShownObserved: true, helperHiddenObserved: true,
    humanShortcutAcceptanceRecorded: true,
    finderLaunchVerified: false, wechatRead: false, externalModelCalls: 0,
  }), { mode: 0o600 });
  console.log('native_acceptance_stage: 两次操作均已收到用户明确确认，现正常退出验收 App。');
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode).toBe(0);
});

// 协调者收到本次用户反馈后才写回收据；窗口状态不会自动产生人工确认。
async function confirmHumanShortcutFeedback(operation: 'show' | 'hide'): Promise<void> {
  const requestId = randomUUID();
  const responsePath = test.info().outputPath(`human-${operation}-${requestId}.json`);
  const requestPath = test.info().outputPath(`human-${operation}-request.json`);
  await writeFile(requestPath, JSON.stringify({ requestId, operation, responsePath }), { mode: 0o600 });
  console.log(`native_acceptance_feedback: ${operation} 等待用户明确确认；协调者请求文件 ${requestPath}`);
  let responseState = 'pending';
  await expect.poll(async () => {
    await verifyAppTestLease();
    try {
      const file = await open(responsePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 1024 || (stat.mode & 0o077) !== 0
            || stat.uid !== process.getuid?.()) return responseState = 'invalid';
        const buffer = Buffer.alloc(1025);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 1024) return responseState = 'invalid';
        const receipt: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
        if (!receipt || typeof receipt !== 'object' || Object.keys(receipt).length !== 2
            || !('requestId' in receipt) || receipt.requestId !== requestId
            || !('confirmed' in receipt) || typeof receipt.confirmed !== 'boolean') {
          return responseState = 'invalid';
        }
        return responseState = receipt.confirmed ? 'confirmed' : 'rejected';
      } finally { await file.close(); }
    } catch (error) {
      return responseState = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'pending' : 'invalid';
    }
  }, { timeout: 90_000, message: '等待本次用户反馈；缺失、失效或否定反馈不算人工验收通过。' }).not.toBe('pending');
  expect(responseState, '本次快捷键操作必须有用户明确确认').toBe('confirmed');
}
