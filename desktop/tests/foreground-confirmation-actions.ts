import { expect, type Page } from '@playwright/test';

// 经真实helper按钮取得当前联系人的本次资格；只核验具名公开状态。
export async function confirmHelperContact(helper: Page, contactId: string): Promise<void> {
  await expect(helper.getByRole('combobox', { name: '本次联系人', exact: true })).toHaveValue(contactId);
  await helper.getByRole('button', { name: '确认本次联系人', exact: true }).click();
  await expect.poll(() => helper.evaluate(async () => {
    const contact = await window.notalone.contacts.getState();
    const foreground = await window.notalone.foreground.getState();
    const reply = await window.notalone.replies.getState();
    return { contactId: contact.selectedContactId, confirmation: foreground.confirmation,
      confirmedContactId: foreground.confirmedContactId, foregroundBlock: foreground.generationBlock,
      replyContactId: reply.contactId, scopeMatches: reply.scopeRevision === contact.scopeRevision,
      replyBlock: reply.generationBlock };
  })).toEqual({ contactId, confirmation: 'manual-confirmed', confirmedContactId: contactId,
    foregroundBlock: null, replyContactId: contactId, scopeMatches: true, replyBlock: null });
}
