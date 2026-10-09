import { expect, type Page } from '@playwright/test';
import type { BindingFixture } from './binding-backend-fixture';

// 旧确认不能恢复新联系人资格；最终直接调用真实生成桥验证main门禁。
export async function foregroundConfirmationSafetyFlow(manager: Page, openHelper: () => Promise<Page>, backend: BindingFixture): Promise<void> {
  const [contactA, contactB] = backend.data.contact_ids;
  expect((await backend.request('/api/sync/cli-bindings/confirm', { selections: [
    { locator: 'wxid_synthetic_a', contact_id: contactA },
  ] })).status).toBe(200);
  expect((await backend.request('/api/sync/status')).data.sync_enabled).toBe(false);
  const observation = await backend.request('/api/sync/foreground/observe', {});
  expect(observation.status).toBe(200);
  expect(['paused', 'unavailable']).toContain(observation.data.phase);
  if (observation.data.phase === 'paused') expect(observation.data.reason).toBe('sync_disabled');
  expect(observation.data.binding_id).toBeNull();
  expect(observation.data.contact_id).toBeNull();
  expect(await backend.tails()).toEqual([]);

  await expect(manager.getByRole('region', { name: '联系人目录', exact: true }).getByRole('button', { name: /^选择/ }).first()).toBeVisible();
  await manager.evaluate(async (contactId) => {
    const state = await window.notalone.contacts.getState();
    await window.notalone.contacts.selectContact({ contactId, scopeRevision: state.scopeRevision });
  }, contactA);
  const helper = await openHelper();
  const picker = helper.getByRole('combobox', { name: '本次联系人', exact: true });
  const editor = helper.getByRole('textbox', { name: '草稿', exact: true });
  await expect(picker).toHaveValue(contactA);
  const draftA = '联系人A的本轮合成草稿';
  await editor.fill(draftA);
  await expect.poll(() => helper.evaluate(async () => (await window.notalone.contacts.getState()).draft)).toBe(draftA);
  const savedA = await helper.evaluate(async () => {
    const contact = await window.notalone.contacts.getState();
    const foreground = await window.notalone.foreground.getState();
    return { contactId: contact.selectedContactId!, contactScopeRevision: contact.scopeRevision,
      foregroundRevision: foreground.foregroundRevision };
  });
  const invalidRejected = await helper.evaluate(async ({ valid, otherContact, otherOwner }) => {
    const confirm = window.notalone.foreground.confirm as unknown as (request: unknown) => Promise<unknown>;
    const invalid = [{ contactId: valid.contactId, contactScopeRevision: valid.contactScopeRevision },
      { ...valid, contactId: 'invalid-uuid' }, { ...valid, contactId: otherContact },
      { ...valid, contactScopeRevision: -1 }, { ...valid, foregroundRevision: 0.5 },
      { ...valid, owner_id: otherOwner }, { ...valid, path: '/api/runtime/shutdown' }];
    const rejected: boolean[] = [];
    for (const request of invalid) {
      try { await confirm(request); rejected.push(false); } catch { rejected.push(true); }
    }
    return rejected;
  }, { valid: savedA, otherContact: backend.data.other_contact_id, otherOwner: backend.data.other_owner_id });
  expect(invalidRejected).toEqual([true, true, true, true, true, true, true]);
  expect(await helper.evaluate(async () => {
    const contact = await window.notalone.contacts.getState();
    const foreground = await window.notalone.foreground.getState();
    return { contactId: contact.selectedContactId, draft: contact.draft, generationBlock: foreground.generationBlock };
  })).toEqual({ contactId: contactA, draft: draftA, generationBlock: 'foreground-confirmation-required' });
  await helper.getByRole('button', { name: '确认本次联系人', exact: true }).click();
  await expect.poll(() => helper.evaluate(async () => {
    const state = await window.notalone.foreground.getState();
    return { confirmation: state.confirmation, confirmedContactId: state.confirmedContactId, generationBlock: state.generationBlock };
  })).toEqual({ confirmation: 'manual-confirmed', confirmedContactId: contactA, generationBlock: null });
  await expect(editor).toHaveValue(draftA);

  // 管理页换B只改变本次选择；不能继承A的helper人工资格。
  await manager.evaluate(async (contactId) => {
    const state = await window.notalone.contacts.getState();
    await window.notalone.contacts.selectContact({ contactId, scopeRevision: state.scopeRevision });
  }, contactB);
  await expect(picker).toHaveValue(contactB);
  const draftB = '联系人B需要重新确认的合成草稿';
  await editor.fill(draftB);
  await expect.poll(() => helper.evaluate(async () => (await window.notalone.contacts.getState()).draft)).toBe(draftB);
  const currentB = await helper.evaluate(async () => {
    const contact = await window.notalone.contacts.getState();
    const foreground = await window.notalone.foreground.getState();
    return { contactId: contact.selectedContactId!, contactScopeRevision: contact.scopeRevision,
      foregroundRevision: foreground.foregroundRevision };
  });
  expect(currentB.contactId).toBe(contactB);
  expect(currentB.contactScopeRevision).toBeGreaterThan(savedA.contactScopeRevision);
  expect(currentB.foregroundRevision).toBeGreaterThan(savedA.foregroundRevision);
  const staleRejected = await helper.evaluate(async ({ savedA, currentB }) => {
    const requests = [savedA, { ...currentB, foregroundRevision: savedA.foregroundRevision },
      { ...currentB, contactScopeRevision: savedA.contactScopeRevision }];
    const rejected: boolean[] = [];
    for (const request of requests) {
      try { await window.notalone.foreground.confirm(request); rejected.push(false); } catch { rejected.push(true); }
    }
    return rejected;
  }, { savedA, currentB });
  expect(staleRejected).toEqual([true, true, true]);
  expect(await manager.evaluate(async (request) => {
    try { await window.notalone.foreground.confirm(request); return false; } catch { return true; }
  }, currentB)).toBe(true);
  expect(await helper.evaluate(async () => {
    const contact = await window.notalone.contacts.getState();
    const foreground = await window.notalone.foreground.getState();
    const reply = await window.notalone.replies.getState();
    return { contactId: contact.selectedContactId, draft: contact.draft, confirmation: foreground.confirmation,
      confirmedContactId: foreground.confirmedContactId, generationBlock: reply.generationBlock, result: reply.result };
  })).toEqual({ contactId: contactB, draft: draftB, confirmation: 'required', confirmedContactId: null,
    generationBlock: 'foreground-confirmation-required', result: null });
  expect(await helper.evaluate(async () => {
    const contact = await window.notalone.contacts.getState();
    try { await window.notalone.replies.generate({ contactId: contact.selectedContactId!, scopeRevision: contact.scopeRevision, newRequest: false }); return null; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })).toContain('请先确认本次联系人');

  const status = await backend.request('/api/sync/status');
  expect(status.status).toBe(200);
  expect(status.data.sync_enabled).toBe(false);
  for (const contactId of [contactA, contactB]) {
    expect((await backend.request(`/api/contacts/${contactId}/messages`)).data.messages).toEqual([]);
  }
  const bindings = (await backend.request('/api/sync/cli-bindings')).data.bindings as { contact_id: string }[];
  expect(bindings.map(binding => binding.contact_id)).toEqual([contactA]);
  expect(await backend.tails()).toEqual([]);
  console.log('foreground_confirmation_safety:', JSON.stringify({ invalidRequests: 7, staleRequests: 3,
    managerRejected: true, generationBlocked: true, syncEnabled: false, tails: 0 }));
}
