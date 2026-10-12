import { confirmHelperContact } from './foreground-confirmation-actions';
import { expect, type Page } from '@playwright/test';
import type { RewriteFixture } from './rewrite-backend-fixture';
import type { RewriteHttpProxy } from './rewrite-http-proxy';

// App 与无头页面复用相同公开交互；原生窗口生命周期另由 App 用例验证。
export interface RewritePages {
  manager: Page;
  helper: Page;
  rewriteBackend: RewriteFixture;
  replyTransport: RewriteHttpProxy;
  screenshotPath?: string;
}

export async function defaultRewrite({ manager, helper, rewriteBackend, screenshotPath }: RewritePages) {
  await expect(helper.getByRole('button', { name: '生成候选', exact: true })).toBeDisabled();
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
  await expect(helper.getByRole('checkbox', { name: '结合关系语境', exact: true })).not.toBeChecked();
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('今晚我会晚一点回复你。');
  await rewriteBackend.plan({ count: 2, risk_notes: ['请核实本次承诺。'] });
  await rewriteBackend.command('hold');
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(helper.getByRole('status').filter({ hasText: '正在等待本次生成结果' })).toBeVisible();
  await rewriteBackend.command('release');
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('我会晚一点回复你（说法1）。');
  await expect(helper.getByRole('textbox', { name: '候选2编辑文本', exact: true })).toHaveValue('我会晚一点回复你（说法2）。');
  await expect(helper.getByRole('radio', { name: '说法 1', exact: true })).toBeChecked();
  await helper.getByRole('radio', { name: '说法 2', exact: true }).click();
  await expect(helper.getByRole('radio', { name: '说法 2', exact: true })).toBeChecked();
  await expect(helper.getByRole('radio', { name: '说法 1', exact: true })).not.toBeChecked();
  await expect(helper.getByText('请核实本次承诺。', { exact: true })).toHaveCount(2);
  await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).fill('我今晚忙完再回复你。');
  await helper.getByText('查看原候选', { exact: true }).first().click();
  await expect(helper.getByText('我会晚一点回复你（说法1）。', { exact: true })).toBeVisible();
  const observations = await rewriteBackend.command('observations');
  const payload = (observations.payloads as Array<Record<string, unknown>>)[0];
  expect(payload).toMatchObject({ input_mode: 'rewrite_draft', draft_text: '今晚我会晚一点回复你。', include_relationship_context: false });
  expect((payload.evidence as Array<{ kind: string }>).map((item) => item.kind)).toEqual(['user_draft']);
  expect(observations.tool_names).toEqual(['read_file', 'ReplyRuntimeOutput']);
  const outbound = JSON.stringify(observations.payloads);
  expect(outbound).not.toContain('甲的私密合成历史');
  expect(outbound).not.toContain('乙的私密合成历史');
  expect(outbound).not.toContain('另一用户的私密合成历史');
  if (screenshotPath) await helper.screenshot({ path: screenshotPath });
}

export async function relationshipScope({ manager, helper, rewriteBackend, replyTransport }: RewritePages) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('今晚我会晚一点回复你。');
  await helper.getByRole('checkbox', { name: '结合关系语境', exact: true }).check();
  await helper.getByRole('textbox', { name: '本次要求', exact: true }).fill('自然一点');
  await rewriteBackend.plan({ probe_history: true });
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toBeVisible();
  const observations = await rewriteBackend.command('observations');
  const payload = (observations.payloads as Array<Record<string, unknown>>)[0];
  expect(payload).toMatchObject({ include_relationship_context: true, user_instruction: '自然一点' });
  expect(JSON.stringify(observations.outbound)).toContain('甲的私密合成历史');
  expect(JSON.stringify(observations.outbound)).not.toContain('乙的私密合成历史');
  expect(JSON.stringify(observations.outbound)).not.toContain('另一用户的私密合成历史');
  const requestId = replyTransport.results[0].data.reply_request_id;
  const evidence = await rewriteBackend.request(`/api/contacts/${rewriteBackend.data.contact_ids[0]}/replies/${requestId}/evidence`);
  expect(evidence.status).toBe(200);
  expect((evidence.data.evidence as Array<{ kind: string }>).map((item) => item.kind).sort()).toEqual(['message', 'user_draft']);
  expect(observations.tool_names).toContain('conversation_search');
  expect(replyTransport.requests[0]).toMatchObject({ contact_id: rewriteBackend.data.contact_ids[0] });
  await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).fill('甲的临时编辑');
  await manager.getByRole('button', { name: '选择合成联系人乙', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('');
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
  await expect(helper.getByRole('checkbox', { name: '结合关系语境', exact: true })).not.toBeChecked();
  await expect(helper.getByRole('textbox', { name: '本次要求', exact: true })).toHaveValue('');
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('');
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
}

export async function unboundRejection({ manager, helper, rewriteBackend, replyTransport }: RewritePages) {
  await rewriteBackend.command('revoke', { contact_id: rewriteBackend.data.contact_ids[0] });
  await expect(manager.getByRole('button', { name: '选择另一用户的联系人', exact: true })).toHaveCount(0);
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('今晚我会晚一点回复你。');
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(helper.getByRole('alert').filter({ hasText: '确认联系人及有效会话绑定' }))
    .toHaveText('本次生成被拒绝，请在管理后台确认联系人及有效会话绑定。');
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
  // 当前助手会话入口在取得default会话前拒绝；必须实证当前联系人409且没有进入生成请求。
  expect(replyTransport.defaultSessionResults.length).toBeGreaterThan(0);
  expect(replyTransport.defaultSessionResults).toEqual(replyTransport.defaultSessionResults.map(() => ({
    contactId: rewriteBackend.data.contact_ids[0], status: 409,
    data: { error: 'assistant_session_rejected', reason: 'no_active_binding' },
  })));
  expect(replyTransport.requests).toEqual([]);
  expect(replyTransport.results).toEqual([]);
  expect((await rewriteBackend.command('observations')).payloads).toEqual([]);
}

export async function idempotentRewrite({ manager, helper, rewriteBackend, replyTransport }: RewritePages) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('今晚我会晚一点回复你。');
  await rewriteBackend.plan({ count: 1 });
  replyTransport.nextReply = 'drop';
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(helper.getByRole('alert')).toContainText('未收到生成结果');
  await helper.getByRole('button', { name: '重试同一次生成', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('我会晚一点回复你（说法1）。');
  expect(replyTransport.requests[0]).toEqual(replyTransport.requests[1]);
  expect(replyTransport.results[0].data).toEqual(replyTransport.results[1].data);
  await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).fill('我忙完再回复你。');
  await helper.getByRole('button', { name: '重试同一次生成', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('我忙完再回复你。');
  await expect.poll(() => replyTransport.results.length).toBe(3);
  expect(replyTransport.results[2].data).toEqual(replyTransport.results[0].data);
  const requestId = replyTransport.results[0].data.reply_request_id;
  const evidence = await rewriteBackend.request(`/api/contacts/${rewriteBackend.data.contact_ids[0]}/replies/${requestId}/evidence`);
  expect(evidence.status).toBe(200);
  expect(evidence.data.evidence).toEqual([expect.objectContaining({ kind: 'user_draft', text: '今晚我会晚一点回复你。' })]);
  await rewriteBackend.plan({ count: 3, prefix: '新生成的说法' });
  await helper.getByRole('button', { name: '重新生成', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选3编辑文本', exact: true })).toHaveValue('新生成的说法（说法3）。');
  expect(replyTransport.requests[3].idempotency_key).not.toBe(replyTransport.requests[0].idempotency_key);
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('明天我会晚一点回复你。');
  await helper.getByRole('combobox', { name: '本次语气', exact: true }).selectOption('warm');
  await helper.getByRole('textbox', { name: '本次要求', exact: true }).fill('只说明时间，不增加承诺');
  await rewriteBackend.plan({ count: 1, prefix: '新输入的说法' });
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('新输入的说法（说法1）。');
  expect(replyTransport.requests[4].idempotency_key).not.toBe(replyTransport.requests[3].idempotency_key);
  expect(replyTransport.requests[4]).toMatchObject({ contact_id: rewriteBackend.data.contact_ids[0], content: {
    type: 'rewrite_draft', draft_text: '明天我会晚一点回复你。', include_relationship_context: false,
    user_instruction: '本次语气自然温和。\n只说明时间，不增加承诺',
  } });
  const observations = await rewriteBackend.command('observations');
  expect(observations.payloads).toHaveLength(3);
}

export async function rewriteFailures({ manager, helper, rewriteBackend, replyTransport }: RewritePages) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('今晚我会晚一点回复你。');
  await rewriteBackend.plan({ count: 1 });
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).fill('保留我的本次编辑。');
  await rewriteBackend.plan({ fault: 'timeout' });
  await helper.getByRole('button', { name: '重新生成', exact: true }).click();
  await expect(helper.getByRole('alert')).toContainText('本次生成超时');
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('保留我的本次编辑。');
  expect(replyTransport.results[1]).toEqual({ status: 504, data: { error: 'reply_timeout' } });
  await rewriteBackend.plan({ count: 2, prefix: '恢复后的说法' });
  await helper.getByRole('button', { name: '重试同一次生成', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选2编辑文本', exact: true })).toHaveValue('恢复后的说法（说法2）。');
  expect(replyTransport.requests[2]).toEqual(replyTransport.requests[1]);
  await helper.getByRole('textbox', { name: '候选2编辑文本', exact: true }).fill('恢复后自己修改的表达。');
  await rewriteBackend.plan({ fault: 'failure' });
  await helper.getByRole('button', { name: '重新生成', exact: true }).click();
  await expect(helper.getByRole('alert')).toContainText('本次生成失败');
  await expect(helper.getByRole('textbox', { name: '候选2编辑文本', exact: true })).toHaveValue('恢复后自己修改的表达。');
  await expect(helper.getByText('合成原始模型错误不应进入界面。', { exact: true })).toHaveCount(0);
  await rewriteBackend.plan({ count: 0 });
  await helper.getByRole('button', { name: '重试同一次生成', exact: true }).click();
  await expect.poll(() => replyTransport.results.length).toBe(5);
  expect(replyTransport.results[4]).toEqual({ status: 500, data: { error: 'reply_generation_failed' } });
  await expect(helper.getByRole('alert')).toContainText('本次生成失败');
  await expect(helper.getByRole('textbox', { name: '候选2编辑文本', exact: true })).toHaveValue('恢复后自己修改的表达。');
}

export async function rewriteSecurity({ manager, helper, rewriteBackend, replyTransport }: RewritePages) {
  await expect(helper.getByRole('button', { name: '生成候选', exact: true })).toBeVisible();
  expect(await helper.evaluate(async (contactId) => {
    const current = await window.notalone.contacts.getState();
    try { await window.notalone.replies.generate({ contactId, scopeRevision: current.scopeRevision, newRequest: false }); return 'accepted'; }
    catch { return 'rejected'; }
  }, rewriteBackend.data.contact_ids[0])).toBe('rejected');
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
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
}

// 只共用公开页面准备与结果断言；App/无头入口各自负责停读和重启生命周期。
export async function prepareTransientRewrite(helper: Page, rewriteBackend: RewriteFixture, includeRelationshipContext = false) {
  await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('已保存的合成改写输入。');
  await helper.getByRole('combobox', { name: '本次语气', exact: true }).selectOption('polite');
  await helper.getByRole('textbox', { name: '本次要求', exact: true }).fill('本次临时要求');
  if (includeRelationshipContext) await helper.getByRole('checkbox', { name: '结合关系语境', exact: true }).check();
  await rewriteBackend.plan({ count: 1 });
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).fill('退出后不恢复的编辑。');
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('退出后不恢复的草稿。');
  await helper.getByRole('textbox', { name: '本次要求', exact: true }).fill('未提交的改写要求。');
}
export async function assertTransientRewriteCleared(helper: Page) {
  await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('');
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
  await expect(helper.getByRole('textbox', { name: '本次要求', exact: true })).toHaveValue('');
  await expect(helper.getByRole('combobox', { name: '本次语气', exact: true })).toHaveValue('original');
  await expect(helper.getByRole('checkbox', { name: '结合关系语境', exact: true })).not.toBeChecked();
}
