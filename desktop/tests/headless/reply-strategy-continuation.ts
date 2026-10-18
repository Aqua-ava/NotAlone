import { openAssistantHistory, expandSavedDiscussion } from '../assistant-history-actions';
import { expect, type Browser, type Page } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withEventPages, type EventPages } from './message-events';

const intention = '只表示感谢，不答应本次邀约。';
async function state(page: Page) { return page.evaluate(() => window.notalone.replies.getState()); }
async function codePointBoundary(page: Page, label: string, button: string) {
  const field = page.getByRole('textbox', { name: label, exact: true });
  const legal = '😀'.repeat(4096);
  await expect(field).not.toHaveAttribute('maxlength', '4096');
  await field.fill(legal);
  await expect(field).toHaveValue(legal);
  await expect(page.getByRole('button', { name: button, exact: true })).toBeEnabled();
  await field.fill(legal + '😀');
  await expect(field).toHaveValue(legal + '😀');
  await expect(page.getByRole('button', { name: button, exact: true })).toBeDisabled();
  await field.fill('');
}
async function saved(pages: EventPages, sessionId: string) {
  const response = await pages.fixture.request(`/api/contacts/${pages.fixture.data.contact_ids[0]}/assistant-sessions/${sessionId}`);
  expect(response.status).toBe(200); expect(Array.isArray(response.data.turns)).toBe(true);
  const turns = response.data.turns as Array<{ input_version_id: string;
    input: { content: Record<string, unknown>; continuation: { submission: Record<string, unknown>; version_id: string } } }>;
  return { turns, current_input_version_id: response.data.current_input_version_id };
}

async function continuationScene(pages: EventPages, scene: '回应消息' | '主动聊聊') {
  const { manager, helper, fixture } = pages;
  expect(fixture.data.migration_count).toBe(55); expect(fixture.data.migration_repeat).toBe(0);
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper, fixture.data.contact_ids[0]);
  await helper.getByRole('button', { name: scene, exact: true }).click();
  if (scene === '回应消息') await helper.getByRole('radio', { name: /甲的原始合成消息/ }).click();
  await helper.getByRole('textbox', { name: scene === '回应消息' ? '表达方向' : '主动目的', exact: true }).fill('拒绝本次邀约。');
  await helper.getByRole('textbox', { name: '本次策略要求', exact: true }).fill('自然一点；不要承诺');
  await fixture.plan({ count: 1, message_groups: [['第一组第一条。', '第一组第二条。']] });
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  const group = helper.getByRole('group', { name: '说法1消息组', exact: true });
  await expect(group.getByRole('textbox', { name: '说法1第2条编辑文本', exact: true })).toHaveValue('第一组第二条。');
  await openAssistantHistory(helper);
  await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
  await expandSavedDiscussion(helper);
  const initial = await state(helper); const sessionId = initial.savedSession!.sessionId!;
  await group.getByRole('textbox', { name: '说法1第2条编辑文本', exact: true }).fill('已保存的第二条编辑。');
  await expect(helper.getByRole('button', { name: '继续修改', exact: true })).toBeDisabled();
  await group.getByRole('button', { name: '保存本组修改', exact: true }).click();
  await expect.poll(async () => (await state(helper)).candidateVersions?.items[0].history?.versions.length).toBe(2);
  const edited = (await state(helper)).candidateVersions!.items[0];
  await codePointBoundary(helper, '继续修改要求', '继续修改');
  await codePointBoundary(helper, '本次改口', '继续修改');
  expect((await fixture.command('observations')).model_calls).toBe(1);
  await fixture.plan({ count: 1, message_groups: [['仅感谢本次邀请。', '本次先不参加。']] });
  await helper.getByRole('textbox', { name: '本次改口', exact: true }).fill(intention);
  await helper.getByRole('textbox', { name: '继续修改要求', exact: true }).fill('第一条简短一点');
  await helper.getByRole('button', { name: '继续修改', exact: true }).click();
  await expect.poll(async () => (await state(helper)).continuation?.phase).toBe('completed');
  const first = await saved(pages, sessionId);
  expect(first.turns).toHaveLength(2);
  expect(first.turns[1].input.continuation.submission.intention_update).toBe(intention);
  expect(first.turns[1].input.continuation.version_id).toBe(edited.displayVersionId);
  expect(first.turns[1].input.content[scene === '回应消息' ? 'direction' : 'purpose']).toBe(intention);
  expect(first.turns[1].input.content.user_instruction).toBe('自然一点；不要承诺；简短一点');
  await expect(helper.getByRole('textbox', { name: '本次改口', exact: true })).toHaveValue('');
  await expect(group.getByRole('textbox', { name: '说法1第2条编辑文本', exact: true })).toHaveValue('本次先不参加。');
  await helper.getByRole('textbox', { name: '继续修改要求', exact: true }).fill('第一条正式一点');
  await helper.getByRole('button', { name: '继续修改', exact: true }).click();
  await expect.poll(async () => (await state(helper)).continuation?.phase).toBe('clarification');
  expect((await saved(pages, sessionId)).current_input_version_id).toBe(first.current_input_version_id);
  expect((await fixture.command('observations')).model_calls).toBe(2);
  await expect(helper.getByRole('combobox', { name: '要求1处理方式', exact: true })).toHaveValue('');
  await expect(helper.getByRole('button', { name: '确认本次要求', exact: true })).toBeDisabled();
  await helper.getByRole('combobox', { name: '要求1处理方式', exact: true }).selectOption('replace');
  await codePointBoundary(helper, '要求1替换内容', '确认本次要求');
  await helper.getByRole('textbox', { name: '要求1替换内容', exact: true }).fill('正式一点');
  await fixture.plan({ count: 1, message_groups: [['感谢本次邀请。', '本次无法参加。']] });
  await helper.getByRole('button', { name: '确认本次要求', exact: true }).click();
  await expect.poll(async () => (await state(helper)).continuation?.phase).toBe('completed');
  const second = await saved(pages, sessionId);
  expect(second.turns).toHaveLength(3);
  expect(second.turns[2].input.continuation.submission.intention_update).toBeUndefined();
  expect(second.turns[2].input.content.type).toBe(scene === '回应消息' ? 'reply_to_message' : 'initiate_conversation');
  expect(second.turns[2].input.content[scene === '回应消息' ? 'direction' : 'purpose']).toBe(intention);
  const actualInputs = (await fixture.command('observations')).payloads as Array<Record<string, unknown>>;
  const reference = actualInputs.at(-1)!.continuation_reference as {
    messages: Array<{ text: string }>; is_current_draft: boolean;
  };
  expect(reference.messages.map((item) => item.text)).toEqual(['仅感谢本次邀请。', '本次先不参加。']);
  expect(reference.is_current_draft).toBe(false);
  expect(second.turns[2].input.content.user_instruction).toBe('正式一点；不要承诺；简短一点');
  const copied = await helper.evaluate(async ({ contactId, sessionId }) => {
    const actual = await window.notalone.replies.getState();
    try { await window.notalone.replies.continueSession({ contactId, scopeRevision: actual.scopeRevision - 1,
      sessionId, instruction: '第一条自然一点' }); return false; } catch { return true; }
  }, { contactId: fixture.data.contact_ids[0], sessionId });
  expect(copied).toBe(true); expect((await fixture.command('observations')).model_calls).toBe(3);
  await fixture.command('append_other_owner'); await fixture.command('publish_foreign_id');
  await pages.awaitPendingCommands();
  expect((await state(helper)).messageNotice.changed).toBe(false);
  const arrived = await fixture.command('append_message');
  await expect(helper.getByRole('status').filter({ hasText: '当前联系人有新消息' })).toBeVisible();
  await expect(group.getByRole('textbox', { name: '说法1第2条编辑文本', exact: true })).toHaveValue('本次无法参加。');
  expect((await fixture.command('observations')).model_calls).toBe(3);
  await fixture.plan({ count: 1, message_groups: [['结合当前新消息的表达。', '保持本次明确意愿。']] });
  await helper.getByRole('button', { name: '结合新消息继续', exact: true }).click();
  await expect(group.getByRole('textbox', { name: '说法1第2条编辑文本', exact: true })).toHaveValue('保持本次明确意愿。');
  const final = await saved(pages, sessionId);
  expect(final.turns).toHaveLength(4);
  expect(final.current_input_version_id).toBe(final.turns[3].input_version_id);
  expect(final.turns[3].input.content[scene === '回应消息' ? 'target_message_id' : 'purpose'])
    .toBe(scene === '回应消息' ? arrived.message_id : intention);
  expect(final.turns[3].input.content.user_instruction).toBe('正式一点；不要承诺；简短一点');
  expect((await state(helper)).messageNotice.changed).toBe(false);
  expect((await fixture.command('observations')).model_calls).toBe(4);
}

export async function replyStrategyContinuation(browser: Browser, origin: string) {
  for (const scene of ['回应消息', '主动聊聊'] as const) {
    const name = `${scene}完整组编辑→明确改口→要求澄清→显式结合真实新消息`;
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withEventPages(browser, origin, (pages) => continuationScene(pages, scene));
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}
