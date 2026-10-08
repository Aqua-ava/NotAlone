import { expect } from '@playwright/test';
import { test } from './rewrite-transport-fixture';

test('受限桥接拒绝管理窗口生成、任意 owner 参数和未选择联系人，不发起业务请求', async ({ runningApp: { app }, rewriteBackend, replyTransport }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
  const helper = await opened;
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('本次合成草稿。');
  const scopeRevision = await helper.evaluate(async () => (await window.notalone.contacts.getState()).scopeRevision);
  const generate = { contactId: rewriteBackend.data.contact_ids[0], scopeRevision, newRequest: false };
  expect(await manager.evaluate(async (selection) => {
    try { await window.notalone.replies.generate(selection); return 'accepted'; } catch { return 'rejected'; }
  }, generate)).toBe('rejected');
  for (const selection of [
    { ...generate, ownerId: '不允许由渲染层指定 owner' },
    { ...generate, contactId: rewriteBackend.data.contact_ids[1] },
    { ...generate, contactId: rewriteBackend.data.other_contact_id },
    { ...generate, scopeRevision: scopeRevision - 1 },
  ]) {
    expect(await helper.evaluate(async (value) => {
      try { await window.notalone.replies.generate(value); return 'accepted'; } catch { return 'rejected'; }
    }, selection)).toBe('rejected');
  }
  expect(replyTransport.requests).toEqual([]);
  expect((await rewriteBackend.command('observations')).payloads).toEqual([]);
  await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('本次合成草稿。');
});
