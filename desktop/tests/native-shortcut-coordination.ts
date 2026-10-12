import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { verifyAppTestLease } from './app-test-gate';
import { readNativeShortcutReceipt, type ShortcutAcceptanceMode } from './native-shortcut-feedback';

// 人工模式须用户明确反馈，Agent模式须实际操作和观察；窗口状态不自动生成收据。
export async function confirmShortcutFeedback(operation: 'external-focus' | 'show' | 'hide', mode: ShortcutAcceptanceMode,
  observe: (timeout: number) => Promise<void>, humanAcceptanceUntil?: number): Promise<void> {
  const requestId = randomUUID();
  const responsePath = test.info().outputPath(`${mode}-${operation}-${requestId}.json`);
  const requestPath = test.info().outputPath(`${mode}-${operation}-request.json`);
  const observationUntil = humanAcceptanceUntil ?? Date.now() + 180_000;
  await writeFile(requestPath, JSON.stringify({ requestId, operation, responsePath, actor: mode,
    observationUntil }), { mode: 0o600 });
  console.log(`native_acceptance_feedback: ${operation} 等待${mode === 'human' ? '用户明确确认' : 'Agent实际操作和观察'}；协调者请求文件 ${requestPath}`);
  await observe(Math.max(1, observationUntil - Date.now()));
  const receiptUntil = humanAcceptanceUntil ?? Date.now() + 90_000;
  // 这是程序观察记录，不能作为人工或Agent实际操作收据。
  await writeFile(test.info().outputPath(`shortcut-${mode}-${operation}-observed.json`), JSON.stringify({
    requestId, operation, observedAt: Date.now(), receiptUntil, userConfirmationRecorded: false,
  }), { mode: 0o600, flag: 'wx' });
  let responseState = 'pending';
  await expect.poll(async () => {
    await verifyAppTestLease();
    return responseState = await readNativeShortcutReceipt(responsePath, requestId, mode);
  }, { timeout: Math.max(1, receiptUntil - Date.now()),
    message: '等待本次对应actor的收据；缺失、失效或否定不算通过。' }).not.toBe('pending');
  expect(responseState, '本次现场操作必须有对应actor的真实收据').toBe('confirmed');
}
