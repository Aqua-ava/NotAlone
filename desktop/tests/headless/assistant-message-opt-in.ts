import { selectContact } from '../contact-picker-actions.mjs';
import { currentMigrationCount } from '../rewrite-backend-fixture';
import { setWorkspaceContext, fillWorkspaceInstruction } from '../workspace-actions';
import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withEventPages, type EventPages } from './message-events';

type Saved = { current_input_version_id: string; turns: Array<{ state: string; input_version_id: string;
  reply: { reply_request_id: string } | null; input: { content: { target_message_id?: string; purpose?: string } } }> };

async function adoptWhileGenerating(pages: EventPages, scene: 'express' | 'suggest') {
  const migrationCount = await currentMigrationCount();
  const { manager, helper, fixture } = pages;
  expect(fixture.data.migration_count).toBe(migrationCount); expect(fixture.data.migration_repeat).toBe(0);
  await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
  await confirmHelperContact(helper, fixture.data.contact_ids[0]);
  await setWorkspaceContext(helper, true);
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('只说明本次立场，不作未来约定。');
  await fillWorkspaceInstruction(helper, '不要承诺');
  const messages = ['当前受控说法第一条。', '当前受控说法第二条。'];
  // 两个模型的返回顺序不作为身份依据，使用真实turn/CURRENT及reply UUID。
  await fixture.plan({ count: 1, message_groups: [messages] });
  await fixture.plan({ count: 1, message_groups: [messages] });
  await fixture.command('hold_generation');
  await helper.getByRole('button', { name: scene === 'express' ? '帮我表达' : '帮我想想', exact: true }).click();
  try {
    await expect.poll(async () => (await fixture.command('observations')).generation_entered).toBe(true);
    const beforeState = await helper.evaluate(() => window.notalone.replies.getState());
    const sessionId = beforeState.savedSession!.sessionId!;
    const path = `/api/contacts/${fixture.data.contact_ids[0]}/assistant-sessions/${sessionId}`;
    const read = async () => {
      const result = await fixture.request(path);
      expect(result.status).toBe(200); return result.data as unknown as Saved;
    };
    const before = await read();
    expect(before.turns).toHaveLength(1); expect(before.turns[0].state).toBe('running');
    const arrived = await fixture.command('append_message');
    await expect(helper.getByRole('status').filter({ hasText: '当前联系人有新消息' })).toBeVisible();
    await expect(helper.getByRole('button', { name: '结合新消息重新生成', exact: true })).toBeEnabled();
    expect((await fixture.command('observations')).model_calls).toBe(0);
    await helper.getByRole('button', { name: '结合新消息重新生成', exact: true }).click();
    await expect.poll(async () => {
      const actual = await read();
      return actual.turns.length === 2 && actual.current_input_version_id !== before.current_input_version_id;
    }).toBe(true);
    await fixture.command('release'); await pages.awaitPendingCommands();
    await expect(helper.getByRole('textbox', { name: '说法1第2条编辑文本', exact: true })).toHaveValue(messages[1]);
    await expect.poll(async () => (await fixture.command('observations')).model_calls).toBe(2);
    const saved = await read();
    expect(saved.turns).toHaveLength(2);
    expect(saved.turns[0].state).toBe('failed'); expect(saved.turns[1].state).toBe('completed');
    expect(saved.current_input_version_id).toBe(saved.turns[1].input_version_id);
    expect(saved.turns[1].input.content).toMatchObject({ type: 'rewrite_draft', input_kind: 'workspace',
      workspace_action: scene, draft_text: '只说明本次立场，不作未来约定。' });
    const evidence = await fixture.request(`/api/contacts/${fixture.data.contact_ids[0]}/replies/${saved.turns[1].reply!.reply_request_id}/evidence`);
    expect(evidence.status).toBe(200);
    expect(JSON.stringify(evidence.data)).toContain(arrived.message_id);
    const current = await helper.evaluate(() => window.notalone.replies.getState());
    expect(current.phase).toBe('ready'); expect(current.result!.replyRequestId).toBe(saved.turns[1].reply!.reply_request_id);
    expect(current.messageNotice.changed).toBe(false);
  } finally { await fixture.command('release'); await pages.awaitPendingCommands(); }
}

export async function assistantMessageOptIn(browser: Browser, origin: string) {
  for (const scene of ['express', 'suggest'] as const) {
    const name = `${scene}实际在途候选明确采用新消息，晚旧模型不覆盖新CURRENT`;
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withEventPages(browser, origin, (pages) => adoptWhileGenerating(pages, scene));
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}
