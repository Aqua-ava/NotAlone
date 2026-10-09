import { confirmHelperContact } from './foreground-confirmation-actions';
import { expect } from '@playwright/test';
import { selectMenu } from './app-fixture';
import { test } from './rewrite-transport-fixture';

test('同联系人隐藏恢复保留编辑，迟到成功和失败都不能串到新联系人', async ({ runningApp: { app }, rewriteBackend, replyTransport }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
  const helper = await opened;
  await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('今晚我会晚一点回复你。');
  await rewriteBackend.plan();
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).fill('本次保留的编辑文本。');
  await helper.getByRole('button', { name: '隐藏输入小窗', exact: true }).click();
  await selectMenu(app, '窗口', '输入小窗');
  await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('今晚我会晚一点回复你。');
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('本次保留的编辑文本。');
  for (const fault of [undefined, 'timeout'] as const) {
    await rewriteBackend.plan({ fault, prefix: '旧联系人迟到结果' });
    replyTransport.nextReply = 'hold';
    await helper.getByRole('button', { name: '重新生成', exact: true }).click();
    await expect(helper.getByRole('status').filter({ hasText: '正在等待本次生成结果' })).toBeVisible();
    await expect.poll(() => replyTransport.heldCount).toBe(fault ? 2 : 1);
    await manager.getByRole('button', { name: '选择合成联系人乙', exact: true }).click();
    await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('乙的新草稿。');
    replyTransport.release();
    await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('乙的新草稿。');
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
    await expect(helper.getByRole('alert')).toHaveCount(0);
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
    await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('今晚我会晚一点回复你。');
    await rewriteBackend.plan();
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toBeVisible();
  }
});

test('换连接废弃迟到结果，并清除当次草稿、候选和编辑', async ({ runningApp: { app }, rewriteBackend, replyTransport }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
  const helper = await opened;
  await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('今晚我会晚一点回复你。');
  await rewriteBackend.plan();
  replyTransport.nextReply = 'hold';
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect.poll(() => replyTransport.heldCount).toBe(1);
  replyTransport.failRuntime = true;
  await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
  await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('');
  replyTransport.release();
  replyTransport.failRuntime = false;
  await manager.getByRole('button', { name: '重试连接', exact: true }).click();
  await manager.getByRole('button', { name: '选择合成联系人乙', exact: true }).click();
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('新连接乙的草稿。');
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
  await expect(helper.getByRole('alert')).toHaveCount(0);
  await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('新连接乙的草稿。');
});
