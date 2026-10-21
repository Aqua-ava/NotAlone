import { selectContact } from '../contact-picker-actions.mjs';
import { currentMigrationCount } from '../rewrite-backend-fixture';
import { setWorkspaceContext, setWorkspaceTone, fillWorkspaceInstruction, openWorkspaceSettings } from '../workspace-actions';
import { openAssistantHistory, expandSavedDiscussion } from '../assistant-history-actions';
import path from 'node:path';
import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import type { RewritePages } from '../rewrite-page-scenarios';
import { RewriteHttpProxy } from '../rewrite-http-proxy';
import { PageHost } from './page-host';
import { withRewritePages } from './rewrite-acceptance';

// 长草稿使首阶段硬限与新会话短草稿的完整生成／复核预算分开，容量仍按实际计量校准。
const draft = '合成预算讨论：' + '今晚不参加，感谢邀请。'.repeat(300);
const instruction = '只保留当前草稿的事实与承诺。';
export { draft as budgetDraft, instruction as budgetInstruction };

export async function prepareDraft({ manager, helper, rewriteBackend }: RewritePages, prefix: string) {
  await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
  await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
  await setWorkspaceContext(helper, false);
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill(draft);
  await setWorkspaceTone(helper, 'polite');
  await fillWorkspaceInstruction(helper, instruction);
  await rewriteBackend.plan({ count: 1, prefix });
}

// 校准和临界生成均由公开页面触发，容量只取真实守卫的纯元数据。
export async function assistantInputBudget(browser: Browser, origin: string) {
  const migrationCount = await currentMigrationCount();
  const name = '接近预算仍生成，温和提醒与历史回执保留当前草稿和临时要求';
  process.stdout.write(`page_test_scenario: ${name}\n`);
  await withRewritePages(browser, origin, async (pages, host, userData) => {
    const { helper, rewriteBackend, replyTransport } = pages;
    await prepareDraft(pages, '预算校准的合成候选');
    await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }))
      .toHaveValue('预算校准的合成候选（说法1）。');
    const calibration = replyTransport.results[0].data.input_budget as { state: string; total_tokens: number };
    expect(calibration.state).toBe('ready');
    expect(calibration.total_tokens).toBeGreaterThan(100);
    // 每轮可能包含候选生成与保真复核，警戒容量须容纳两阶段。
    const stages = await rewriteBackend.command('calibration');
    const capacity = Number(stages.maximum_stage_total) + 100;
    const initial = await rewriteBackend.command('metrics');
    expect(initial).toEqual({ model_calls: 1, migration_count: migrationCount, migration_repeat: 0 });
    await host.close();
    await rewriteBackend.command('configure', { capacity });
    const transport = await RewriteHttpProxy.attach(rewriteBackend.infoPath);
    try {
      const next = new PageHost(await browser.newContext(), origin, userData);
      try {
        await next.backend.connect();
        const manager = await next.open('manager');
        const opened = manager.context().waitForEvent('page');
        await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
        const current: RewritePages = { manager, helper: await opened, rewriteBackend, replyTransport: transport };
        await prepareDraft(current, '临界预算的合成候选');
        await openAssistantHistory(current.helper);
        await current.helper.getByRole('button', { name: '新开助手会话', exact: true }).click();
        await expect(current.helper.getByText('当前会话还没有讨论。', { exact: true })).toBeVisible();
        // 新开明确清空临时输入后，用户重新填入同一校准请求。
        await setWorkspaceContext(current.helper, false);
        await current.helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill(draft);
        await setWorkspaceTone(current.helper, 'polite');
        await fillWorkspaceInstruction(current.helper, instruction);
        await current.helper.getByRole('button', { name: '帮我表达', exact: true }).click();
        await expect(current.helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }))
          .toHaveValue('临界预算的合成候选（说法1）。');
        const generated = transport.results[0];
        expect(generated.status).toBe(200);
        expect(generated.data.input_budget).toMatchObject({ state: 'warning', allowed: true, context_window_tokens: capacity });
        const metrics = await rewriteBackend.command('metrics');
        expect(metrics).toEqual({ model_calls: 2, migration_count: migrationCount, migration_repeat: 0 });
        process.stdout.write(`page_test_budget_warning: http=200 state=warning model_calls=2 initial_total=${calibration.total_tokens} capacity=${capacity} migrations=${migrationCount} repeat=0\n`);
        await expect(current.helper.getByRole('status', { name: '模型输入预算', exact: true }))
          .toContainText('当前讨论已接近模型输入上限');
        await expect(current.helper.getByRole('alert', { name: '模型输入预算', exact: true })).toHaveCount(0);
        await expect(current.helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue(draft);
        await expect(current.helper.getByRole('combobox', { name: '本次语气', exact: true })).toHaveValue('polite');
        await expect(current.helper.getByRole('textbox', { name: '本次要求', exact: true })).toHaveValue(instruction);
        await expect(current.helper.getByRole('checkbox', { name: '参考最近聊天和相关关系资料', exact: true })).not.toBeChecked();
        await openAssistantHistory(current.helper);
        await current.helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
        await expandSavedDiscussion(current.helper);
        const discussion = current.helper.getByRole('region', { name: '已保存的讨论', exact: true });
        await expect(discussion.getByText(draft, { exact: true })).toBeVisible();
        await expect(discussion.getByText('临界预算的合成候选（说法1）。', { exact: true })).toBeVisible();
        await expect(discussion.getByRole('status', { name: '当时的模型输入预算', exact: true }))
          .toContainText('这轮生成当时已接近模型输入上限。');
        const sessionId = (await current.helper.evaluate(async () => window.notalone.replies.getState())).savedSession!.sessionId!;
        const saved = await rewriteBackend.request(`/api/contacts/${rewriteBackend.data.contact_ids[0]}/assistant-sessions/${sessionId}`);
        expect(saved.status).toBe(200);
        expect((saved.data.turns as Array<{ reply: { input_budget: unknown } }>)[0].reply.input_budget)
          .toEqual(generated.data.input_budget);
        expect((await rewriteBackend.command('metrics')).model_calls).toBe(2);
      } finally { transport.release(); await next.close(); }
    } finally { await transport.close(); }
  }, undefined, path.resolve('tests/fixtures/assistant-input-budget-page-backend.py'));
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}
