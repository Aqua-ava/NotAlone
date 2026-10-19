import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';

// 方向选择已退役：直接给建议，用户也可自行提出想法后表达。
export async function replyStrategyOptions(browser: Browser, origin: string) {
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
    process.stdout.write('page_test_scenario: 工作区空输入建议、换组与自行表达\n');
    const contactId = rewriteBackend.data.contact_ids[0];
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, contactId);
    const idea = helper.getByRole('textbox', { name: '有什么想说的', exact: true });
    await expect(idea).toHaveValue('');
    await expect(helper.getByRole('button', { name: '帮我表达', exact: true })).toBeDisabled();
    await rewriteBackend.plan({ count: 3, prefix: '尚未采纳的合成思路', basis: '根据最近聊天提出可选说法，尚未代表用户立场。' });
    await helper.getByRole('button', { name: '帮我想想', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选3编辑文本', exact: true })).toHaveValue('尚未采纳的合成思路（说法3）。');
    await expect(helper.getByText('根据最近聊天提出可选说法，尚未代表用户立场。', { exact: true })).toHaveCount(3);
    await expect(helper.getByText('根据最近聊天提出可选说法，尚未代表用户立场。', { exact: true }).first()).toBeVisible();
    await expect(idea).toHaveValue('');
    expect(replyTransport.explorationRequests).toHaveLength(0);
    const first = replyTransport.requests[0];
    expect(first).toMatchObject({ content: { input_kind: 'workspace', workspace_action: 'suggest', draft_text: '' } });
    const firstPayloads = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
    expect(firstPayloads).toHaveLength(1);
    expect(firstPayloads[0]).toMatchObject({ input_mode: 'workspace', fidelity_contract: { current_intent: null } });
    await rewriteBackend.plan({ count: 2, prefix: '另一组可选说法' });
    await helper.getByRole('button', { name: '帮我想想', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选2编辑文本', exact: true })).toHaveValue('另一组可选说法（说法2）。');
    expect(replyTransport.requests.at(-1)?.idempotency_key).not.toBe(first.idempotency_key);
    // 不选择候选也能自行表达；建议不能自动填入本人想法。
    await expect(idea).toHaveValue('');
    await idea.fill('只说明本次收到了消息，不安排后续。');
    await rewriteBackend.plan({ count: 1, prefix: '我已收到，先到这里' });
    await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('我已收到，先到这里（说法1）。');
    expect(replyTransport.requests.at(-1)).toMatchObject({ content: { input_kind: 'workspace', workspace_action: 'express',
      draft_text: '只说明本次收到了消息，不安排后续。' } });
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(3);
    for (const name of ['回应消息', '主动聊聊', '帮我理清方向', '生成候选']) {
      await expect(helper.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
  });
}
