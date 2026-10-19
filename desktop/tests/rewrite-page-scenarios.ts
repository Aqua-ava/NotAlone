import { setWorkspaceContext, setWorkspaceTone, fillWorkspaceInstruction, openWorkspaceSettings } from './workspace-actions';
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
  await expect(helper.getByRole('button', { name: '帮我表达', exact: true })).toBeDisabled();
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
  await setWorkspaceContext(helper, false);
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('今晚我会晚一点回复你。');
  await rewriteBackend.plan({ count: 2, risk_notes: ['请核实本次承诺。'] });
  await rewriteBackend.command('hold');
  await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  await expect(helper.getByRole('status').filter({ hasText: '正在等待本次生成结果' })).toBeVisible();
  await rewriteBackend.command('release');
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('我会晚一点回复你（说法1）。');
  await expect(helper.getByRole('textbox', { name: '候选2编辑文本', exact: true })).toHaveValue('我会晚一点回复你（说法2）。');
  await expect(helper.getByRole('group', { name: '说法1消息组', exact: true })).toBeVisible();
  await expect(helper.getByRole('group', { name: '说法2消息组', exact: true })).toBeVisible();
  await expect(helper.getByText('请核实本次承诺。', { exact: true })).toHaveCount(2);
  const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
  await editor.fill('我今晚忙完再回复你。');
  await editor.blur();
  await helper.getByRole('button', { name: '查看说法1上一版', exact: true }).click();
  await expect(editor).toHaveValue('我会晚一点回复你（说法1）。');
  await expect(helper.getByRole('textbox', { name: '候选2编辑文本', exact: true })).toHaveValue('我会晚一点回复你（说法2）。');
  const observations = await rewriteBackend.command('observations');
  const payload = (observations.payloads as Array<Record<string, unknown>>)[0];
  expect(payload).toMatchObject({ input_mode: 'workspace', draft_text: '今晚我会晚一点回复你。', include_relationship_context: false });
  expect((payload.evidence as Array<{ kind: string }>).map((item) => item.kind).sort()).toEqual(['user_draft', 'user_purpose']);
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
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('今晚我会晚一点回复你。');
  await setWorkspaceContext(helper, true);
  await fillWorkspaceInstruction(helper, '自然一点');
  await rewriteBackend.plan({ probe_history: true });
  await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
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
  expect((evidence.data.evidence as Array<{ kind: string }>).map((item) => item.kind).sort()).toEqual(['message', 'user_draft', 'user_purpose']);
  expect(observations.tool_names).toContain('conversation_search');
  expect(observations.tool_names).toContain('ReplyRuntimeOutput');
  // probe_history 先请求真实检索，再取得检索结果生成；切换不得增加这次已完成调用链。
  const modelCallsBeforeSwitch = (observations.payloads as unknown[]).length;
  expect(modelCallsBeforeSwitch).toBeGreaterThan(0);
  expect(replyTransport.requests[0]).toMatchObject({ contact_id: rewriteBackend.data.contact_ids[0] });
  const savedVersions = await helper.evaluate(async () => {
    const state = await window.notalone.replies.getState();
    return state.candidateVersions?.items[0]?.history?.versions;
  });
  expect(savedVersions).toHaveLength(1);
  expect(savedVersions![0].messages.map(message => message.text)).toEqual(['我会晚一点回复你（说法1）。']);
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('甲未提交的临时想法。');
  await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).fill('甲的临时编辑');
  await manager.getByRole('button', { name: '选择合成联系人乙', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('');
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
  // 新联系人使用工作区默认上下文设置，不继承上一个联系人的临时要求。
  await expect(helper.getByRole('checkbox', { name: '参考最近聊天和相关关系资料', exact: true })).toBeChecked();
  await expect(helper.getByRole('textbox', { name: '本次要求', exact: true })).toHaveValue('');
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
  // 同一 App 内按联系人恢复临时输入；恢复前仍复验原会话与候选版本，不能越到乙的范围。
  await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('甲未提交的临时想法。');
  await expect(helper.getByRole('group', { name: '说法1消息组', exact: true }).getByRole('textbox')).toHaveValue('甲的临时编辑');
  expect(await helper.evaluate(async () => {
    const state = await window.notalone.replies.getState();
    return state.candidateVersions?.items[0]?.history?.versions;
  })).toEqual(savedVersions);
  expect((await rewriteBackend.command('observations')).payloads).toHaveLength(modelCallsBeforeSwitch);
}

export async function unboundRejection({ manager, helper, rewriteBackend, replyTransport }: RewritePages) {
  await rewriteBackend.command('revoke', { contact_id: rewriteBackend.data.contact_ids[0] });
  await expect(manager.getByRole('button', { name: '选择另一用户的联系人', exact: true })).toHaveCount(0);
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await helper.getByRole('button', { name: '确认本次联系人', exact: true }).click();
  await expect.poll(async () => (await helper.evaluate(async () => window.notalone.replies.getState())).generationBlock)
    .toBe('foreground-confirmation-required');
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('今晚我会晚一点回复你。');
  await expect(helper.getByRole('button', { name: '帮我表达', exact: true })).toBeDisabled();
  await expect(helper.getByRole('button', { name: '帮我想想', exact: true })).toBeDisabled();
  expect(await helper.evaluate(async () => {
    const state = await window.notalone.replies.getState();
    try { await window.notalone.replies.generate({ contactId: state.contactId!, scopeRevision: state.scopeRevision, newRequest: true }); return 'accepted'; }
    catch { return 'rejected'; }
  })).toBe('rejected');
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
  await setWorkspaceContext(helper, false);
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('今晚我会晚一点回复你。');
  await rewriteBackend.plan({ count: 1 });
  replyTransport.nextReply = 'drop';
  await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  await expect(helper.getByRole('alert')).toContainText('未收到生成结果');
  await helper.getByRole('button', { name: '重试同一次生成', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('我会晚一点回复你（说法1）。');
  expect(replyTransport.requests[0]).toEqual(replyTransport.requests[1]);
  expect(replyTransport.results[0].data).toEqual(replyTransport.results[1].data);
  await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).fill('我忙完再回复你。');
  await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).blur();
  // 已完成请求经公开桥重放，核验幂等结果不会覆盖保存的编辑；首次与新请求仍由页面按钮触发。
  await helper.evaluate(async () => { const state = await window.notalone.replies.getState();
    await window.notalone.replies.generate({ contactId: state.contactId!, scopeRevision: state.scopeRevision, newRequest: false }); });
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('我忙完再回复你。');
  await expect.poll(() => replyTransport.results.length).toBe(3);
  expect(replyTransport.results[2].data).toEqual(replyTransport.results[0].data);
  const requestId = replyTransport.results[0].data.reply_request_id;
  const evidence = await rewriteBackend.request(`/api/contacts/${rewriteBackend.data.contact_ids[0]}/replies/${requestId}/evidence`);
  expect(evidence.status).toBe(200);
  expect(evidence.data.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'user_draft', text: '今晚我会晚一点回复你。' })]));
  expect((evidence.data.evidence as Array<{ kind: string }>).map((item) => item.kind).sort()).toEqual(['user_draft', 'user_purpose']);
  await rewriteBackend.plan({ count: 3, prefix: '新生成的说法' });
  await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选3编辑文本', exact: true })).toHaveValue('新生成的说法（说法3）。');
  expect(replyTransport.requests[3].idempotency_key).not.toBe(replyTransport.requests[0].idempotency_key);
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('明天我会晚一点回复你。');
  await setWorkspaceTone(helper, 'warm');
  await fillWorkspaceInstruction(helper, '只说明时间，不增加承诺');
  await rewriteBackend.plan({ count: 1, prefix: '新输入的说法' });
  await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('新输入的说法（说法1）。');
  expect(replyTransport.requests[4].idempotency_key).not.toBe(replyTransport.requests[3].idempotency_key);
  expect(replyTransport.requests[4]).toMatchObject({ contact_id: rewriteBackend.data.contact_ids[0], content: {
    type: 'rewrite_draft', input_kind: 'workspace', workspace_action: 'express',
    draft_text: '明天我会晚一点回复你。', include_relationship_context: false,
    user_instruction: '本次语气自然温和。\n只说明时间，不增加承诺',
  } });
  const observations = await rewriteBackend.command('observations');
  expect(observations.payloads).toHaveLength(3);
}

export async function rewriteFailures({ manager, helper, rewriteBackend, replyTransport }: RewritePages) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('今晚我会晚一点回复你。');
  await rewriteBackend.plan({ count: 1 });
  await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).fill('保留我的本次编辑。');
  await rewriteBackend.plan({ fault: 'timeout' });
  await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  await expect(helper.getByRole('alert')).toContainText('本次生成超时');
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('保留我的本次编辑。');
  expect(replyTransport.results[1]).toEqual({ status: 504, data: { error: 'reply_timeout' } });
  await rewriteBackend.plan({ count: 2, prefix: '恢复后的说法' });
  await helper.getByRole('button', { name: '重试同一次生成', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选2编辑文本', exact: true })).toHaveValue('恢复后的说法（说法2）。');
  expect(replyTransport.requests[2]).toEqual(replyTransport.requests[1]);
  await helper.getByRole('textbox', { name: '候选2编辑文本', exact: true }).fill('恢复后自己修改的表达。');
  await rewriteBackend.plan({ fault: 'failure' });
  await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
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
  await expect(helper.getByRole('button', { name: '帮我表达', exact: true })).toBeVisible();
  expect(await helper.evaluate(async (contactId) => {
    const current = await window.notalone.contacts.getState();
    try { await window.notalone.replies.generate({ contactId, scopeRevision: current.scopeRevision, newRequest: false }); return 'accepted'; }
    catch { return 'rejected'; }
  }, rewriteBackend.data.contact_ids[0])).toBe('rejected');
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('本次合成草稿。');
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
  await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('本次合成草稿。');
}

// 只共用公开页面准备与结果断言；App/无头入口各自负责停读和重启生命周期。
export async function prepareTransientRewrite(helper: Page, rewriteBackend: RewriteFixture, includeRelationshipContext = false) {
  await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('已保存的合成改写输入。');
  await setWorkspaceTone(helper, 'polite');
  await fillWorkspaceInstruction(helper, '本次临时要求');
  await setWorkspaceContext(helper, includeRelationshipContext);
  await rewriteBackend.plan({ count: 1 });
  await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('退出后不恢复的草稿。');
  await fillWorkspaceInstruction(helper, '未提交的改写要求。');
  // 最后保持编辑焦点，退出前不触发版本自动保存。
  await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).fill('退出后不恢复的编辑。');
}
export async function assertWorkspaceRecovery(helper: Page) {
  await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('');
  await expect(helper.getByRole('group', { name: '说法1消息组', exact: true }).getByRole('textbox')).toHaveValue('我会晚一点回复你（说法1）。');
  await openWorkspaceSettings(helper);
  await expect(helper.getByRole('textbox', { name: '本次要求', exact: true })).toHaveValue('');
  await expect(helper.getByRole('combobox', { name: '本次语气', exact: true })).toHaveValue('original');
  await helper.getByText('最近聊天 · 查看／补充', { exact: true }).click();
  await expect(helper.getByRole('checkbox', { name: '参考最近聊天和相关关系资料', exact: true })).toBeChecked();
}
