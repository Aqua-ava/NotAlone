import { confirmHelperContact } from '../foreground-confirmation-actions';
import { expect, type Browser } from '@playwright/test';
import { withRewritePages } from './rewrite-acceptance';
import type { RewritePages } from '../rewrite-page-scenarios';
import { PageHost } from './page-host';

async function confirmedTarget({ manager, helper, replyTransport, rewriteBackend }: RewritePages) {
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
    await helper.getByRole('button', { name: '回应消息', exact: true }).click({ timeout: 3000 });
    await expect(helper.getByRole('textbox', { name: '表达方向', exact: true })).toHaveValue('');
    await expect(helper.getByRole('radio', { name: /甲的私密合成历史/ })).not.toBeChecked();
    await expect(helper.getByRole('button', { name: '生成候选', exact: true })).toBeDisabled();
    await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('说明今晚晚点回复，不增加承诺。');
    await expect(helper.getByRole('button', { name: '生成候选', exact: true })).toBeDisabled();
    await helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
    await expect(helper.getByRole('button', { name: '生成候选', exact: true })).toBeEnabled();
    await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('  ');
    await expect(helper.getByRole('button', { name: '生成候选', exact: true })).toBeDisabled();
    expect(replyTransport.requests).toEqual([]);
    await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('说明今晚晚点回复，不增加承诺。');
    await rewriteBackend.plan({ count: 2, prefix: '我忙完再回复你' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('我忙完再回复你（说法1）。', { timeout: 4000 });
    expect(replyTransport.requests).toHaveLength(1);
    const messages = await rewriteBackend.request(`/api/contacts/${rewriteBackend.data.contact_ids[0]}/messages`);
    expect(replyTransport.requests[0]).toMatchObject({ contact_id: rewriteBackend.data.contact_ids[0], content: {
      type: 'reply_to_message', target_message_id: (messages.data.messages as Array<{ message_id: string }>)[0].message_id,
      direction: '说明今晚晚点回复，不增加承诺。', direction_source: 'direct_input',
    } });
    const payload = ((await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>)[0];
    expect(payload).toMatchObject({ input_mode: 'reply_to_message', current_text: '甲的私密合成历史：今晚我会晚一点回复你。',
      confirmed_direction: '说明今晚晚点回复，不增加承诺。', direction_source: 'direct_input' });
    expect(JSON.stringify(payload)).not.toContain('乙的私密合成历史');
    expect(JSON.stringify(payload)).not.toContain('另一用户的私密合成历史');
    await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).fill('我晚上忙完再回复。');
    await helper.getByText('查看原候选', { exact: true }).first().click();
    await expect(helper.getByText('我忙完再回复你（说法1）。', { exact: true })).toBeVisible();
    await helper.getByText('这组候选的生成输入 · 合成联系人甲', { exact: true }).click();
    await expect(helper.getByText('表达方向：说明今晚晚点回复，不增加承诺。', { exact: true })).toBeVisible();
    await helper.screenshot({ path: 'artifacts/headless-pages/directed-reply-candidates.png' });
}

async function messagePages({ manager, helper, replyTransport, rewriteBackend }: RewritePages) {
  await rewriteBackend.command('older_messages');
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
  await helper.getByRole('button', { name: '回应消息', exact: true }).click();
  const targets = helper.getByRole('group', { name: '待回复消息', exact: true });
  await expect(targets.getByRole('radio')).toHaveCount(20);
  await expect(targets.getByRole('radio', { checked: true })).toHaveCount(0);
  await expect(helper.getByText('乙的私密合成历史：今晚我会晚一点回复你。', { exact: true })).toHaveCount(0);
  await expect(helper.getByText('另一用户的私密合成历史：今晚我会晚一点回复你。', { exact: true })).toHaveCount(0);
  const first = await rewriteBackend.request(`/api/contacts/${rewriteBackend.data.contact_ids[0]}/messages?limit=20`);
  const before = first.data.next_cursor as string;
  expect(before).toMatch(/^[a-f0-9-]{36}$/);
  await helper.getByRole('button', { name: '加载更早消息', exact: true }).click();
  await expect(targets.getByRole('radio')).toHaveCount(22);
  await expect(helper.getByRole('button', { name: '加载更早消息', exact: true })).toHaveCount(0);
  expect(replyTransport.messageRequests).toEqual([
    `/api/contacts/${rewriteBackend.data.contact_ids[0]}/messages?limit=20`,
    `/api/contacts/${rewriteBackend.data.contact_ids[0]}/messages?limit=20`,
    `/api/contacts/${rewriteBackend.data.contact_ids[0]}/messages?limit=20&before=${before}`,
  ]);
  const last = await rewriteBackend.request(`/api/contacts/${rewriteBackend.data.contact_ids[0]}/messages?limit=20&before=${before}`);
  await helper.getByRole('radio', { name: /甲的较早合成消息 21/ }).click();
  await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('回应第 21 条较早消息。');
  await rewriteBackend.plan({ count: 1, prefix: '回应较早消息' });
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('回应较早消息（说法1）。');
  expect(replyTransport.requests[0]).toMatchObject({ content: { target_message_id: (last.data.messages as Array<{ message_id: string }>)[1].message_id } });
  const payloads = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
  expect(payloads[0]).toMatchObject({ current_text: '甲的较早合成消息 21', confirmed_direction: '回应第 21 条较早消息。' });
}

async function unavailableTarget({ manager, helper, replyTransport, rewriteBackend }: RewritePages) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
  await helper.getByRole('button', { name: '回应消息', exact: true }).click();
  await helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
  await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('说明现在的安排。');
  await rewriteBackend.command('withdraw_target_source');
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(helper.getByRole('alert')).toContainText('本次生成失败');
  expect(replyTransport.results).toEqual([{ status: 500, data: { error: 'reply_generation_failed' } }]);
  expect((await rewriteBackend.command('observations')).payloads).toEqual([]);
  await expect(helper.getByText('可以刷新待回复消息重新选择，或切换到草稿改写。', { exact: true })).toBeVisible();
  await helper.getByRole('button', { name: '刷新消息', exact: true }).click();
  await expect(helper.getByText('这位联系人暂无可用消息，可以使用草稿改写。', { exact: true })).toBeVisible();
  await expect(helper.getByRole('button', { name: '生成候选', exact: true })).toBeDisabled();
  await helper.getByRole('button', { name: '改写', exact: true }).click();
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('我会稍晚再回复。');
  await rewriteBackend.plan({ count: 1, prefix: '转为草稿' });
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('转为草稿（说法1）。');
  expect(replyTransport.requests[1]).toMatchObject({ content: { type: 'rewrite_draft', include_relationship_context: false } });
}

async function inputIdentity({ manager, helper, replyTransport, rewriteBackend }: RewritePages) {
  await rewriteBackend.command('older_messages');
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
  await helper.getByRole('button', { name: '回应消息', exact: true }).click();
  await helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
  await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('第一版明确方向。');
  await rewriteBackend.plan({ count: 1, prefix: '第一版回复' });
  replyTransport.nextReply = 'drop';
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(helper.getByRole('alert')).toContainText('未收到生成结果');
  await helper.getByRole('button', { name: '重试同一次生成', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('第一版回复（说法1）。');
  expect(replyTransport.requests[1]).toEqual(replyTransport.requests[0]);
  expect(replyTransport.results[1].data).toEqual(replyTransport.results[0].data);
  await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).fill('保留我的编辑。');
  await helper.getByRole('button', { name: '重试同一次生成', exact: true }).click();
  await expect.poll(() => replyTransport.results.length).toBe(3);
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('保留我的编辑。');
  expect(replyTransport.results[2].data).toEqual(replyTransport.results[0].data);
  await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('第二版明确方向。');
  await helper.getByText('这组候选的生成输入 · 合成联系人甲', { exact: true }).click();
  await expect(helper.getByText('表达方向：第一版明确方向。', { exact: true })).toBeVisible();
  await rewriteBackend.plan({ count: 1, prefix: '方向变更' });
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('方向变更（说法1）。');
  expect(replyTransport.requests[3].idempotency_key).not.toBe(replyTransport.requests[0].idempotency_key);
  expect(replyTransport.requests[3]).toMatchObject({ content: { direction: '第二版明确方向。' } });
  await helper.getByRole('radio', { name: /甲的较早合成消息 01/ }).click();
  await rewriteBackend.plan({ count: 1, prefix: '目标变更' });
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('目标变更（说法1）。');
  expect(replyTransport.requests[4].idempotency_key).not.toBe(replyTransport.requests[3].idempotency_key);
  expect((replyTransport.requests[4].content as Record<string, unknown>).target_message_id)
    .not.toBe((replyTransport.requests[3].content as Record<string, unknown>).target_message_id);
  await helper.getByRole('button', { name: '改写', exact: true }).click();
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('本次改写草稿。');
  await rewriteBackend.plan({ count: 1, prefix: '改写模式' });
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('改写模式（说法1）。');
  expect(replyTransport.requests[5].idempotency_key).not.toBe(replyTransport.requests[4].idempotency_key);
  expect(replyTransport.requests[5]).toMatchObject({ content: { type: 'rewrite_draft', include_relationship_context: false } });
  await helper.getByRole('button', { name: '回应消息', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '表达方向', exact: true })).toHaveValue('第二版明确方向。');
  await rewriteBackend.plan({ count: 3, prefix: '再回回复模式' });
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选3编辑文本', exact: true })).toHaveValue('再回回复模式（说法3）。');
  expect(replyTransport.requests[6].idempotency_key).not.toBe(replyTransport.requests[4].idempotency_key);
  await rewriteBackend.plan({ fault: 'timeout' });
  await helper.getByRole('button', { name: '重新生成', exact: true }).click();
  await expect(helper.getByRole('alert')).toContainText('本次生成超时');
  expect(replyTransport.results[7]).toEqual({ status: 504, data: { error: 'reply_timeout' } });
  await rewriteBackend.plan({ count: 1, prefix: '同键失败恢复' });
  await helper.getByRole('button', { name: '重试同一次生成', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('同键失败恢复（说法1）。');
  expect(replyTransport.requests[8]).toEqual(replyTransport.requests[7]);
  expect(replyTransport.requests[7].idempotency_key).not.toBe(replyTransport.requests[6].idempotency_key);
  expect((await rewriteBackend.command('observations')).payloads).toHaveLength(7);
}

async function emptyAndRejected({ manager, helper, replyTransport, rewriteBackend }: RewritePages) {
  await manager.getByRole('button', { name: '选择无消息的合成联系人', exact: true }).click();
  await helper.getByRole('button', { name: '回应消息', exact: true }).click();
  await expect(helper.getByText('这位联系人暂无可用消息，可以使用草稿改写。', { exact: true })).toBeVisible();
  await expect(helper.getByRole('button', { name: '生成候选', exact: true })).toBeDisabled();
  expect(replyTransport.requests).toEqual([]);
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
  replyTransport.failMessages = true;
  await helper.getByRole('button', { name: '回应消息', exact: true }).click();
  await expect(helper.getByRole('alert')).toContainText('消息读取失败');
  await expect(helper.getByRole('radio')).toHaveCount(0);
  replyTransport.failMessages = false;
  await helper.getByRole('button', { name: '刷新消息', exact: true }).click();
  await helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
  await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('明确说明现在的安排。');
  await rewriteBackend.command('revoke', { contact_id: rewriteBackend.data.contact_ids[0] });
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(helper.getByRole('alert')).toContainText('确认联系人及有效会话绑定');
  expect(replyTransport.results).toEqual([{ status: 409, data: { error: 'reply_rejected', reason: 'no_active_binding' } }]);
  expect((await rewriteBackend.command('observations')).payloads).toEqual([]);
  await expect(helper.getByText('可以刷新待回复消息重新选择，或切换到草稿改写。', { exact: true })).toBeVisible();
  await helper.getByRole('button', { name: '改写', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toBeVisible();
  await expect(helper.getByRole('checkbox', { name: '结合关系语境', exact: true })).not.toBeChecked();
}

async function prepareReply(pages: RewritePages, contact: '甲' | '乙', direction: string) {
  await pages.manager.getByRole('button', { name: `选择合成联系人${contact}`, exact: true }).click();
  await confirmHelperContact(pages.helper, pages.rewriteBackend.data.contact_ids[contact === '甲' ? 0 : 1]);
  await pages.helper.getByRole('button', { name: '回应消息', exact: true }).click();
  await pages.helper.getByRole('radio', { name: new RegExp(`${contact}的私密合成历史`) }).click();
  await pages.helper.getByRole('textbox', { name: '表达方向', exact: true }).fill(direction);
}
// 显式等待公开具名操作结束，不用截图时机或测试收尾掩盖迟到回填。
function pendingReply(pages: RewritePages) {
  return pages.helper.evaluate(async () => {
    const state = await window.notalone.contacts.getState();
    await window.notalone.replies.generate({ contactId: state.selectedContactId!, scopeRevision: state.scopeRevision, newRequest: true });
    return 'completed';
  });
}
async function staleMessages(pages: RewritePages, connection: boolean) {
  const { helper, manager, replyTransport } = pages;
  for (const failed of [false, true]) {
    await prepareReply(pages, '甲', '甲的旧方向。');
    replyTransport.failMessages = failed;
    replyTransport.nextMessages = 'hold';
    const heldBefore = replyTransport.heldCount;
    const pending = helper.evaluate(async () => {
      const state = await window.notalone.contacts.getState();
      await window.notalone.replies.loadMessages({ contactId: state.selectedContactId!, scopeRevision: state.scopeRevision, older: false });
      return 'completed';
    });
    await expect(helper.getByRole('status').filter({ hasText: '正在读取这位联系人的消息' })).toBeVisible();
    await expect.poll(() => replyTransport.heldCount).toBe(heldBefore + 1);
    replyTransport.failMessages = false;
    if (connection) {
      replyTransport.failRuntime = true;
      await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
      await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('');
      replyTransport.failRuntime = false;
      await manager.getByRole('button', { name: '重试连接', exact: true }).click();
    }
    await manager.getByRole('button', { name: '选择合成联系人乙', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('');
    await helper.getByRole('button', { name: '回应消息', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '表达方向', exact: true })).toHaveValue('');
    await expect(helper.getByRole('radio', { name: /乙的私密合成历史/ })).not.toBeChecked();
    await helper.getByRole('radio', { name: /乙的私密合成历史/ }).click();
    await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('乙的新方向。');
    replyTransport.release();
    expect(await pending).toBe('completed');
    await expect(helper.getByRole('textbox', { name: '表达方向', exact: true })).toHaveValue('乙的新方向。');
    await expect(helper.getByRole('radio', { name: /乙的私密合成历史/ })).toBeChecked();
    await expect(helper.getByText('甲的私密合成历史：今晚我会晚一点回复你。', { exact: true })).toHaveCount(0);
    await expect(helper.getByRole('alert')).toHaveCount(0);
  }
}
async function staleGenerated(pages: RewritePages, connection: boolean) {
  const { helper, manager, replyTransport, rewriteBackend } = pages;
  for (const fault of [undefined, 'failure'] as const) {
    await prepareReply(pages, '甲', '甲的旧方向。');
    await rewriteBackend.plan({ count: 1, fault, prefix: '迟到的旧回复' });
    replyTransport.nextReply = 'hold';
    const heldBefore = replyTransport.heldCount;
    const pending = pendingReply(pages);
    await expect.poll(() => replyTransport.heldCount).toBe(heldBefore + 1);
    expect(replyTransport.results.at(-1)?.status).toBe(fault ? 500 : 200);
    if (connection) {
      replyTransport.failRuntime = true;
      await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
      await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('');
      replyTransport.failRuntime = false;
      await manager.getByRole('button', { name: '重试连接', exact: true }).click();
    }
    await manager.getByRole('button', { name: '选择合成联系人乙', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('');
    await helper.getByRole('button', { name: '回应消息', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '表达方向', exact: true })).toHaveValue('');
    await expect(helper.getByRole('radio', { name: /乙的私密合成历史/ })).not.toBeChecked();
    await helper.getByRole('radio', { name: /乙的私密合成历史/ }).click();
    await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('乙的新方向。');
    replyTransport.release();
    expect(await pending).toBe('completed');
    await expect(helper.getByRole('textbox', { name: '表达方向', exact: true })).toHaveValue('乙的新方向。');
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
    await expect(helper.getByRole('alert')).toHaveCount(0);
    await expect(helper.getByText('迟到的旧回复（说法1）。', { exact: true })).toHaveCount(0);
  }
}

async function parameterGuards(pages: RewritePages) {
  const { helper, manager, rewriteBackend, replyTransport } = pages;
  await prepareReply(pages, '甲', '安全检查方向。');
  const otherMessages = await rewriteBackend.request(`/api/contacts/${rewriteBackend.data.contact_ids[1]}/messages`);
  const otherMessageId = (otherMessages.data.messages as Array<{ message_id: string }>)[0].message_id;
  const denied = await helper.evaluate(async ({ outside, other, otherMessageId }) => {
    const state = await window.notalone.contacts.getState();
    const scope = { contactId: state.selectedContactId!, scopeRevision: state.scopeRevision };
    const invalid: Array<[string, 'setMode' | 'loadMessages' | 'selectMessage' | 'updateDirection', unknown[]]> = [
      ['outside contact', 'setMode', [{ ...scope, contactId: other, mode: 'reply_to_message' }]],
      ['outside owner', 'loadMessages', [{ ...scope, contactId: outside, older: false }]],
      ['stale scope', 'updateDirection', [{ ...scope, scopeRevision: scope.scopeRevision - 1, direction: '旧范围' }]],
      ['owner field', 'loadMessages', [{ ...scope, ownerId: 'not-authorized', older: false }]],
      ['url field', 'loadMessages', [{ ...scope, url: 'https://invalid.example', older: false }]],
      ['cursor field', 'loadMessages', [{ ...scope, before: otherMessageId, older: true }]],
      ['invalid boolean', 'loadMessages', [{ ...scope, older: 'true' }]],
      ['invalid mode', 'setMode', [{ ...scope, mode: 'suggest_direction' }]],
      ['outside target', 'selectMessage', [{ ...scope, messageId: otherMessageId }]],
      ['invalid target', 'selectMessage', [{ ...scope, messageId: 'https://invalid.example' }]],
      ['oversized direction', 'updateDirection', [{ ...scope, direction: 'x'.repeat(4097) }]],
      ['extra argument', 'updateDirection', [{ ...scope, direction: '不应修改方向' }, { ownerId: 'not-authorized' }]],
    ];
    const result: Record<string, boolean> = {};
    for (const [name, operation, args] of invalid) {
      try { await Reflect.apply(window.notalone.replies[operation], window.notalone.replies, args); result[name] = false; }
      catch { result[name] = true; }
    }
    return result;
  }, { outside: rewriteBackend.data.other_contact_id, other: rewriteBackend.data.contact_ids[1], otherMessageId });
  for (const [name, rejected] of Object.entries(denied)) expect(rejected, name).toBe(true);
  const selection = await helper.evaluate(async () => {
    const state = await window.notalone.contacts.getState();
    return { contactId: state.selectedContactId!, scopeRevision: state.scopeRevision };
  });
  expect(await manager.evaluate(async (scope) => {
    const operations = [() => window.notalone.replies.setMode({ ...scope, mode: 'reply_to_message' }),
      () => window.notalone.replies.loadMessages({ ...scope, older: false }),
      () => window.notalone.replies.updateDirection({ ...scope, direction: '错误窗口' })];
    return Promise.all(operations.map(async (operation) => { try { await operation(); return false; } catch { return true; } }));
  }, selection)).toEqual([true, true, true]);
  await expect(helper.getByRole('textbox', { name: '表达方向', exact: true })).toHaveValue('安全检查方向。');
  expect(replyTransport.requests).toEqual([]);
  expect((await rewriteBackend.command('observations')).payloads).toEqual([]);
}

async function newReplySession(pages: RewritePages, host: PageHost, userData: string, browser: Browser, origin: string) {
  const { helper, rewriteBackend } = pages;
  await prepareReply(pages, '甲', '重启后不恢复的方向。');
  await rewriteBackend.plan({ count: 1, prefix: '本次临时回复' });
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).fill('重启后不恢复的编辑。');
  await host.close();
  await rewriteBackend.command('restart');
  const restarted = new PageHost(await browser.newContext(), origin, userData);
  try {
    await restarted.backend.connect();
    const manager = await restarted.open('manager');
    const nextHelper = await restarted.open('helper');
    await expect(manager.getByText('本次联系人：未确认', { exact: true })).toBeVisible();
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await expect(nextHelper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('');
    await expect(nextHelper.getByRole('checkbox', { name: '结合关系语境', exact: true })).not.toBeChecked();
    await expect(nextHelper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
    await nextHelper.getByRole('button', { name: '回应消息', exact: true }).click();
    await expect(nextHelper.getByRole('textbox', { name: '表达方向', exact: true })).toHaveValue('');
    await expect(nextHelper.getByRole('radio', { name: /甲的私密合成历史/ })).not.toBeChecked();
    await expect(nextHelper.getByRole('button', { name: '生成候选', exact: true })).toBeDisabled();
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  } finally { await restarted.close(); }
}

export async function directedReply(browser: Browser, origin: string) {
  const scenarios: Array<[string, (pages: RewritePages, host: PageHost, userData: string) => Promise<void>]> = [
    ['明确选择、非空方向、真实请求与可编辑快照', confirmedTarget],
    ['当前联系人真实消息分页与较早目标', messagePages],
    ['目标退出可用范围后真实失败并可转草稿', unavailableTarget],
    ['同键恢复和编辑保留、模式目标方向改变使用新键', inputIdentity],
    ['无消息、读取失败重试与有效绑定撤销后真实拒绝', emptyAndRejected],
    ['联系人切换后迟到列表成功和失败失效', (pages) => staleMessages(pages, false)],
    ['断线重连后迟到列表成功和失败失效', (pages) => staleMessages(pages, true)],
    ['联系人切换后迟到生成成功和失败失效', (pages: RewritePages) => staleGenerated(pages, false)],
    ['断线重连后迟到生成成功和失败失效', (pages: RewritePages) => staleGenerated(pages, true)],
    ['具名参数、消息目标、角色和范围拒绝', parameterGuards],
    ['新生产会话不恢复目标、方向和编辑', (pages, host, userData) => newReplySession(pages, host, userData, browser, origin)],
  ];
  for (const [name, scenario] of scenarios) {
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withRewritePages(browser, origin, scenario);
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}
