import { currentMigrationCount } from '../rewrite-backend-fixture';
import { setWorkspaceContext, setWorkspaceTone, fillWorkspaceInstruction, openWorkspaceSettings } from '../workspace-actions';
import { openAssistantHistory, expandSavedDiscussion } from '../assistant-history-actions';
import path from 'node:path';
import { expect, type Browser } from '@playwright/test';
import type { RewritePages } from '../rewrite-page-scenarios';
import { RewriteHttpProxy } from '../rewrite-http-proxy';
import { PageHost } from './page-host';
import { withRewritePages } from './rewrite-acceptance';
import { budgetDraft, budgetInstruction, prepareDraft } from './assistant-input-budget';

// 先由真实页面计量，只有合成fixture声明容量；不改变模型或产品上限。
export async function assistantInputBudgetHard(browser: Browser, origin: string) {
  const migrationCount = await currentMigrationCount();
  const name = '硬预算零模型，完整草稿和旧讨论可查看，明确新开后独立生成';
  process.stdout.write(`page_test_scenario: ${name}\n`);
  await withRewritePages(browser, origin, async (pages, host, userData) => {
    const { helper, rewriteBackend, replyTransport } = pages;
    await prepareDraft(pages, '硬预算校准的合成候选');
    await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }))
      .toHaveValue('硬预算校准的合成候选（说法1）。');
    const calibration = replyTransport.results[0].data.input_budget as { total_tokens: number };
    expect(calibration.total_tokens).toBeGreaterThan(101);
    const savedState = await helper.evaluate(async () => window.notalone.replies.getState());
    const originalSessionId = savedState.savedSession!.sessionId!;
    const originalPath = `/api/contacts/${rewriteBackend.data.contact_ids[0]}/assistant-sessions/${originalSessionId}`;
    const before = await rewriteBackend.request(originalPath);
    expect(before.status).toBe(200);
    expect((await rewriteBackend.command('metrics')).model_calls).toBe(1);
    // 在 prepare 的首阶段就阻断，不能用最终复核预算代替首次计量。
    const stages = await rewriteBackend.command('calibration');
    const capacity = Number(stages.first_stage_total) - 1;
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
        await prepareDraft(current, '硬预算后的新会话合成候选');
        await current.helper.getByRole('button', { name: '帮我表达', exact: true }).click();
        const notice = current.helper.getByRole('alert', { name: '模型输入预算', exact: true });
        await expect(notice).toContainText('超限调用已停止');
        expect(transport.replyPreparationBudgets).toHaveLength(1);
        expect(transport.replyPreparationBudgets[0].status).toBe(409);
        expect(transport.requests).toEqual([]);
        expect(transport.results).toEqual([]);
        expect(transport.replyPreparationBudgets[0].inputBudget).toMatchObject({
          state: 'exceeded', allowed: false, context_window_tokens: capacity,
        });
        expect(await rewriteBackend.command('metrics')).toEqual({
          model_calls: 1, migration_count: migrationCount, migration_repeat: 0,
        });
        await expect(current.helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue(budgetDraft);
        await expect(current.helper.getByRole('combobox', { name: '本次语气', exact: true })).toHaveValue('polite');
        await expect(current.helper.getByRole('textbox', { name: '本次要求', exact: true })).toHaveValue(budgetInstruction);
        await expect(current.helper.getByRole('checkbox', { name: '参考最近聊天和相关关系资料', exact: true })).not.toBeChecked();
        await openAssistantHistory(current.helper);
        await current.helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
        await expandSavedDiscussion(current.helper);
        const discussion = current.helper.getByRole('region', { name: '已保存的讨论', exact: true });
        await expect(discussion.getByText('硬预算校准的合成候选（说法1）。', { exact: true })).toBeVisible();
        await expect(discussion.getByText(budgetDraft, { exact: true }).first()).toBeVisible();
        const rejectedSaved = await rewriteBackend.request(originalPath);
        expect(rejectedSaved.status).toBe(200);
        const originalTurn = (before.data.turns as Array<{ turn_id: string }>)[0];
        expect((rejectedSaved.data.turns as Array<{ turn_id: string }>).find((turn) => turn.turn_id === originalTurn.turn_id))
          .toEqual(originalTurn);
        await openAssistantHistory(current.helper);
        await current.helper.getByRole('button', { name: '新开助手会话', exact: true }).click();
        await expect(current.helper.getByText('当前会话还没有讨论。', { exact: true })).toBeVisible();
        await expect(current.helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('');
        await openWorkspaceSettings(current.helper);
        await expect(current.helper.getByRole('textbox', { name: '本次要求', exact: true })).toHaveValue('');
        await expect(current.helper.getByRole('combobox', { name: '本次语气', exact: true })).toHaveValue('original');
        expect((await rewriteBackend.command('metrics')).model_calls).toBe(1);
        const fresh = await current.helper.evaluate(async () => window.notalone.replies.getState());
        expect(fresh.savedSession!.sessionId).not.toBe(originalSessionId);
        expect((await rewriteBackend.request(originalPath)).data).toEqual(rejectedSaved.data);
        await current.helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('独立的新合成草稿。');
        await current.helper.getByRole('button', { name: '帮我表达', exact: true }).click();
        await expect(current.helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }))
          .toHaveValue('硬预算后的新会话合成候选（说法1）。');
        expect(await rewriteBackend.command('metrics')).toEqual({
          // 新会话只新增一次候选生成。
          model_calls: 2, migration_count: migrationCount, migration_repeat: 0,
        });
        process.stdout.write(`page_test_budget_hard: rejected_http=409 model_delta=0 capacity=${capacity} old_history_preserved=true blank_model_delta=0 explicit_new_generation=true total_model_calls=2 migrations=${migrationCount} repeat=0\n`);
      } finally { transport.release(); await next.close(); }
    } finally { await transport.close(); }
  }, undefined, path.resolve('tests/fixtures/assistant-input-budget-page-backend.py'));
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}
