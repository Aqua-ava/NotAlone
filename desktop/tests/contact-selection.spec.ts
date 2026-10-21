import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { test } from './contact-fixture';

test('目录外联系人 ID 与过期草稿调用不能改变当前双窗口会话', async ({ runningApp: { app }, contactBackend }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption(contactBackend.data.contact_ids[0]);
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗' }).click();
  const helper = await opened;
  const draft = helper.getByRole('textbox', { name: '草稿' });
  await draft.fill('甲的当前草稿。');
  // 非目录 ID 无法从界面选择；通过公开具名桥接验证参数边界，结果仍看真实两窗。
  for (const contactId of [contactBackend.data.other_contact_id, randomUUID()]) {
    const rejected = await helper.evaluate(async (contactId) => {
      const state = await window.notalone.contacts.getState();
      try { await window.notalone.contacts.selectContact({ contactId, scopeRevision: state.scopeRevision }); return false; }
      catch { return true; }
    }, contactId);
    expect(rejected).toBe(true);
    await expect(helper.getByRole('combobox', { name: '本次联系人' })).toHaveValue(contactBackend.data.contact_ids[0]);
    await expect(draft).toHaveValue('甲的当前草稿。');
  }
  const oldScope = await helper.evaluate(async () => (await window.notalone.contacts.getState()).scopeRevision);
  await manager.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption(contactBackend.data.contact_ids[1]);
  await expect(helper.getByRole('combobox', { name: '本次联系人' })).toHaveValue(contactBackend.data.contact_ids[1]);
  await draft.fill('乙的当前草稿。');
  const rejectedDraft = await helper.evaluate(async ({ contactId, scopeRevision }) => {
    try { await window.notalone.contacts.setDraft({ contactId, scopeRevision, text: '迟到的甲草稿。' }); return false; }
    catch { return true; }
  }, { contactId: contactBackend.data.contact_ids[0], scopeRevision: oldScope });
  expect(rejectedDraft).toBe(true);
  await expect(manager.getByRole('combobox', { name: '本次联系人', exact: true })).toHaveValue(contactBackend.data.contact_ids[1]);
  await expect(draft).toHaveValue('乙的当前草稿。');
});
