import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { test } from './app-fixture';

// 此用例故意等待预约到期；仅由主 Agent 显式执行，runner 预期退出 124。
test.skip(process.env.NOTALONE_APP_TEST_EXPIRY_ACCEPTANCE !== '1', '只在有限预约的到期收尾验收中执行');

test('本轮原生窗口就绪后等待预约到期，由统一门禁收尾', async ({ runningApp: { app, appProcess, userData } }) => {
  test.setTimeout(60_000);
  const manager = await app.firstWindow();
  await expect(manager.getByRole('heading', { name: '联系人', exact: true })).toBeVisible();
  await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
  // 只记录本 fixture 返回的进程与自有目录，供命令结束后只读核验；不写握手或正文。
  await writeFile(test.info().outputPath('owned-app.json'), JSON.stringify({
    pid: appProcess.pid, userData, ready: true,
  }), { mode: 0o600 });
  console.log('app_test_expiry_ready: 本轮原生窗口已就绪，等待预约到期。');
  await app.waitForEvent('close', { timeout: 60_000 });
});
