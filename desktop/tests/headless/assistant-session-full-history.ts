import path from 'node:path';
import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';

// 夹具通过正式HTTP保存合法历史；页面仍经默认JsonClient与同一来源读取边界。
export async function assistantSessionFullHistory(browser: Browser, origin: string) {
  const name = '超过1MiB完整历史可查看，硬预算零模型，明确新开保留旧讨论';
  process.stdout.write(`page_test_scenario: ${name}\n`);
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
    const history = await rewriteBackend.command('large_history');
    expect(history.wire_bytes).toBeGreaterThan(1_048_576);
    expect(history.characters_per_input).toBe(100_000);
    expect(await rewriteBackend.command('metrics')).toEqual({ model_calls: 0, migration_count: 55, migration_repeat: 0 });
    await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
    const discussion = helper.getByRole('region', { name: '已保存的讨论', exact: true });
    for (const letter of '甲乙丙丁') await expect(discussion.getByText(letter.repeat(100_000), { exact: true })).toBeVisible();
    const state = await helper.evaluate(async () => window.notalone.replies.getState());
    expect(state.savedSession!.phase).toBe('ready');
    expect(state.savedSession!.sessionId).toBe(history.session_id);
    expect(state.savedSession!.inputs.map((input) => input.inputVersionId)).toEqual(history.input_version_ids);
    expect(state.savedSession!.inputs.map((input) => input.content!.type === 'purpose_exploration'
      ? input.content!.purposeHint : '')).toEqual(Array.from('甲乙丙丁', (letter) => letter.repeat(100_000)));
    await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('超大完整讨论中的合成新草稿。');
    await helper.getByRole('textbox', { name: '本次要求', exact: true }).fill('仅保留本次合成草稿的事实。');
    await rewriteBackend.plan({ count: 1, prefix: '全新会话独立的合成候选' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(helper.getByRole('alert', { name: '模型输入预算', exact: true })).toContainText('超限调用已停止');
    expect(replyTransport.results[0].status).toBe(409);
    expect(replyTransport.results[0].data.input_budget).toMatchObject({ state: 'exceeded', allowed: false });
    expect((await rewriteBackend.command('metrics')).model_calls).toBe(0);
    await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('超大完整讨论中的合成新草稿。');
    await expect(helper.getByRole('textbox', { name: '本次要求', exact: true })).toHaveValue('仅保留本次合成草稿的事实。');
    await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
    for (const letter of '甲乙丙丁') await expect(discussion.getByText(letter.repeat(100_000), { exact: true })).toBeVisible();
    const originalPath = `/api/contacts/${rewriteBackend.data.contact_ids[0]}/assistant-sessions/${history.session_id}`;
    const rejected = await rewriteBackend.request(originalPath);
    expect(rejected.status).toBe(200);
    await helper.getByRole('button', { name: '新开助手会话', exact: true }).click();
    await expect(helper.getByText('当前会话还没有讨论。', { exact: true })).toBeVisible();
    await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('');
    await expect(helper.getByRole('textbox', { name: '本次要求', exact: true })).toHaveValue('');
    expect((await rewriteBackend.command('metrics')).model_calls).toBe(0);
    const fresh = await helper.evaluate(async () => window.notalone.replies.getState());
    expect(fresh.savedSession!.sessionId).not.toBe(history.session_id);
    expect((await rewriteBackend.request(originalPath)).data).toEqual(rejected.data);
    await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('只属于新会话的合成草稿。');
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }))
      .toHaveValue('全新会话独立的合成候选（说法1）。');
    expect(await rewriteBackend.command('metrics')).toEqual({ model_calls: 1, migration_count: 55, migration_repeat: 0 });
    process.stdout.write(`page_test_full_history: wire_bytes=${history.wire_bytes} inputs=4 characters_per_input=100000 read_model_delta=0 exceeded_http=409 exceeded_model_delta=0 blank_model_delta=0 explicit_model_calls=1 migrations=55 repeat=0\n`);
  }, undefined, path.resolve('tests/fixtures/assistant-input-budget-page-backend.py'));
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}
