import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';

// 公开页面复用生产控制器；删除归属和不可恢复结果从真实 HTTP / PostgreSQL 重读。
export async function assistantSessionDeletion(browser: Browser, origin: string) {
  const name = '确认后清除助手讨论，取消保留讨论，独立样本仍可管理';
  process.stdout.write(`page_test_scenario: ${name}\n`);
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend }) => {
    const contactId = rewriteBackend.data.contact_ids[0];
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, contactId);
    await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('需要主动删除的合成讨论。');
    await rewriteBackend.plan({ count: 1, prefix: '需要清除的合成候选' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }))
      .toHaveValue('需要清除的合成候选（说法1）。');
    await helper.getByText('我的表达样本', { exact: true }).click();
    await helper.getByRole('textbox', { name: '手工表达样本', exact: true }).fill('删除会话后独立保留的合成样本。');
    await helper.getByRole('button', { name: '主动保存手工文字', exact: true }).click();
    const samples = helper.getByRole('list', { name: '表达样本目录', exact: true });
    await expect(samples.getByText('删除会话后独立保留的合成样本。', { exact: true })).toBeVisible();
    await helper.getByText('我的表达样本', { exact: true }).click();
    await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
    const session = await helper.evaluate(async () => window.notalone.replies.getState());
    const sessionId = session.savedSession!.sessionId!;
    const path = `/api/contacts/${contactId}/assistant-sessions/${sessionId}`;
    expect((await rewriteBackend.request(path)).status).toBe(200);

    await helper.getByRole('button', { name: '删除当前助手会话', exact: true }).click();
    const confirmation = helper.getByRole('group', { name: '确认删除助手会话', exact: true });
    await expect(confirmation.getByText('已主动保存的表达样本仍会保留，可在表达样本管理中单独删除。', { exact: true })).toBeVisible();
    await confirmation.getByRole('button', { name: '管理表达样本', exact: true }).click();
    await expect(samples.getByText('删除会话后独立保留的合成样本。', { exact: true })).toBeVisible();
    await confirmation.getByRole('button', { name: '取消删除会话', exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    expect((await rewriteBackend.request(path)).status).toBe(200);
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }))
      .toHaveValue('需要清除的合成候选（说法1）。');

    await helper.getByRole('button', { name: '删除当前助手会话', exact: true }).click();
    await confirmation.getByRole('button', { name: '确认删除会话', exact: true }).click();
    await expect(helper.getByRole('status').filter({ hasText: '当前助手会话已删除' })).toBeVisible();
    expect(await rewriteBackend.request(path)).toEqual({ status: 404, data: { error: 'not_found' } });
    await expect(helper.getByRole('region', { name: '已保存的讨论', exact: true })).toHaveCount(0);
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
    await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('');
    expect(await helper.evaluate(async () => window.notalone.replies.getState())).toMatchObject({
      result: null, selectedCandidateId: null, canRetry: false, direction: '', purpose: '',
      savedSession: { sessionId: null, turns: [] },
    });
    await expect(samples.getByText('删除会话后独立保留的合成样本。', { exact: true })).toBeVisible();
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  });
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}
