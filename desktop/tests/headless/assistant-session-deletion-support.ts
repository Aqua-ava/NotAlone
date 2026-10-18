import { openAssistantHistory, expandSavedDiscussion } from '../assistant-history-actions';
import { readFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import type { RewriteFixture } from '../rewrite-backend-fixture';
import type { RewritePages } from '../rewrite-page-scenarios';

export async function chooseDeletionContact(pages: RewritePages, index: 0 | 1 = 0) {
  await pages.manager.getByRole('button', { name: index === 0 ? '选择合成联系人甲' : '选择合成联系人乙', exact: true }).click();
  await confirmHelperContact(pages.helper, pages.rewriteBackend.data.contact_ids[index]);
  await expect.poll(() => pages.helper.evaluate(async () => (await window.notalone.replies.getState()).savedSession?.phase)).toBe('ready');
}

export async function saveDeletionDiscussion(pages: RewritePages, draft: string, prefix: string, options = false) {
  await chooseDeletionContact(pages);
  await pages.helper.getByRole('textbox', { name: '草稿', exact: true }).fill(draft);
  if (options) {
    await pages.helper.getByRole('combobox', { name: '本次语气', exact: true }).selectOption('polite');
    await pages.helper.getByRole('textbox', { name: '本次要求', exact: true }).fill('会话删除时也要清除的合成要求。');
    await pages.helper.getByRole('checkbox', { name: '结合关系语境', exact: true }).check();
  }
  await pages.rewriteBackend.plan({ count: 1, prefix });
  await pages.helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(pages.helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue(`${prefix}（说法1）。`);
  await openAssistantHistory(pages.helper);
  await pages.helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
  await expandSavedDiscussion(pages.helper);
  await expect(pages.helper.getByRole('region', { name: '已保存的讨论', exact: true }).getByText(draft, { exact: true })).toBeVisible();
  const state = await pages.helper.evaluate(async () => window.notalone.replies.getState());
  const contactId = pages.rewriteBackend.data.contact_ids[0];
  const sessionId = state.savedSession!.sessionId!;
  return { contactId, sessionId, path: `/api/contacts/${contactId}/assistant-sessions/${sessionId}` };
}

export async function confirmDeletion(helper: Page) {
  await openAssistantHistory(helper);
  await helper.getByRole('button', { name: '删除当前助手会话', exact: true }).click();
  await helper.getByRole('group', { name: '确认删除助手会话', exact: true })
    .getByRole('button', { name: '确认删除会话', exact: true }).click();
}

export async function expectDeletionCleared(helper: Page) {
  await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('');
  await expect(helper.getByRole('textbox', { name: '本次要求', exact: true })).toHaveValue('');
  await expect(helper.getByRole('combobox', { name: '本次语气', exact: true })).toHaveValue('original');
  await expect(helper.getByRole('checkbox', { name: '结合关系语境', exact: true })).not.toBeChecked();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
  await expect(helper.getByRole('region', { name: '已保存的讨论', exact: true })).toHaveCount(0);
  expect(await helper.evaluate(async () => window.notalone.replies.getState())).toMatchObject({
    result: null, selectedCandidateId: null, canRetry: false, phase: 'idle',
    mode: 'rewrite_draft', direction: '', purpose: '', targetMessageId: null,
    options: { tone: 'original', instruction: '', includeRelationshipContext: false },
    savedSession: { sessionId: null, turns: [] },
  });
}

// 仅对本轮合成夹具执行真实 DELETE；用于另一个已确认客户端删除和跨范围拒绝的安排。
export async function deleteFixtureSession(fixture: RewriteFixture, contactId: string, sessionId: string) {
  const info = await readFile(fixture.infoPath, 'utf8');
  const address = /^address=(127\.0\.0\.1:\d+)$/m.exec(info)?.[1];
  const token = /^token=([^\n]+)$/m.exec(info)?.[1];
  if (!address || !token) throw new Error('本轮受控握手未就绪。');
  const response = await fetch(`http://${address}/api/contacts/${contactId}/assistant-sessions/${sessionId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed: true }),
  });
  return { status: response.status, data: await response.json() as Record<string, unknown> };
}
