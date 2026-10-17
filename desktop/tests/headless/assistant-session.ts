import { selectMemoryCategory } from '../memory-page-actions';
import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';

// 公开页面与真实 HTTP/PG；模型仅返回固定合成候选。
export async function assistantSessionPersistence(browser: Browser, origin: string) {
  process.stdout.write('page_test_scenario: 默认保存与同键重放\n');
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend }) => {
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
    await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('合成讨论：明天再确认时间。');
    await rewriteBackend.plan({ count: 2, prefix: '可靠保存的合成候选' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }))
      .toHaveValue('可靠保存的合成候选（说法1）。');
    await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
    const discussion = helper.getByRole('region', { name: '已保存的讨论', exact: true });
    await expect(discussion.getByText('合成讨论：明天再确认时间。', { exact: true })).toBeVisible();
    await expect(discussion.getByText('可靠保存的合成候选（说法1）。', { exact: true })).toBeVisible();
    await helper.getByRole('button', { name: '重试同一次生成', exact: true }).click();
    await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
    await expect(discussion.getByRole('article')).toHaveCount(1);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  });
  process.stdout.write('page_test_scenario_passed: 默认保存与同键重放\n');
  process.stdout.write('page_test_scenario: 来源待删除遮挡与无关讨论保留\n');
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend }) => {
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
    await helper.getByRole('button', { name: '回应消息', exact: true }).click();
    await helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
    await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('依赖来源的合成讨论。');
    await rewriteBackend.plan({ count: 1, prefix: '依赖来源的合成候选' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }))
      .toHaveValue('依赖来源的合成候选（说法1）。');
    // 控制输入只改变合成来源状态；尚未清理时也不能重新读出正文。
    await rewriteBackend.command('withdraw_target_source');
    await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
    const discussion = helper.getByRole('region', { name: '已保存的讨论', exact: true });
    await expect(discussion.getByText('相关来源不可用', { exact: true })).toBeVisible();
    await expect(discussion.getByText('依赖来源的合成讨论。', { exact: true })).toHaveCount(0);
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);

    await helper.getByRole('button', { name: '改写', exact: true }).click();
    await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('与来源无关的合成讨论。');
    await rewriteBackend.plan({ count: 1, prefix: '与来源无关的合成候选' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }))
      .toHaveValue('与来源无关的合成候选（说法1）。');
    await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
    await expect(discussion.getByText('与来源无关的合成讨论。', { exact: true })).toBeVisible();
    await expect(discussion.getByText('与来源无关的合成候选（说法1）。', { exact: true })).toBeVisible();
    await expect(discussion.getByText('依赖来源的合成候选（说法1）。', { exact: true })).toHaveCount(0);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(2);
  });
  process.stdout.write('page_test_scenario_passed: 来源待删除遮挡与无关讨论保留\n');
  process.stdout.write('page_test_scenario: 迟到依据响应不能恢复暂存候选\n');
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
    const unrelated = await rewriteBackend.command('unrelated_source');
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
    await helper.getByRole('button', { name: '回应消息', exact: true }).click();
    await helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
    await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('迟到核验不得恢复合成候选。');
    await rewriteBackend.plan({ count: 1, prefix: '不可复活的合成候选' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
    await expect(editor).toHaveValue('不可复活的合成候选（说法1）。');
    await manager.getByRole('button', { name: '记忆', exact: true }).click();
    await selectMemoryCategory(manager, '来源与过程');
    const card = manager.getByRole('region', { name: '来源删除管理', exact: true })
      .getByRole('listitem').filter({ hasText: `来源标识：${unrelated.source_id}` });
    // 删除无关来源触发生产核验；暂停真实200响应，再让实际依赖来源失效。
    replyTransport.nextEvidence = 'hold';
    await card.getByRole('button', { name: '删除来源', exact: true }).click();
    await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
    await expect.poll(() => replyTransport.heldEvidenceStatuses).toEqual([200]);
    expect(await manager.evaluate(async () => (await window.notalone.sources.getState()).busySourceId)).toBe(unrelated.source_id);
    expect(await helper.evaluate(async () => window.notalone.replies.getState()))
      .toMatchObject({ result: null, sourceAvailability: 'checking' });
    await expect(editor).toHaveCount(0);
    await rewriteBackend.command('withdraw_target_source');
    const readsBefore = replyTransport.sessionReads.length;
    // 等公开读取命令实际完成，确保迟到依据在失效读取之后交付。
    await helper.evaluate(async () => {
      const contact = await window.notalone.contacts.getState();
      await window.notalone.replies.readSavedSession({ contactId: contact.selectedContactId!, scopeRevision: contact.scopeRevision });
    });
    await expect.poll(() => replyTransport.sessionReads.length).toBe(readsBefore + 1);
    expect(replyTransport.sessionReads.at(-1)).toEqual({ status: 200, states: ['unavailable'] });
    replyTransport.release();
    await expect.poll(() => manager.evaluate(async () => (await window.notalone.sources.getState()).busySourceId)).toBeNull();
    // 公共命令重读在删除操作结束后核验权威状态，避免跨页面render尚未收到事件而假通过。
    expect(await helper.evaluate(async () => window.notalone.replies.getState()))
      .toMatchObject({ phase: 'idle', result: null, selectedCandidateId: null });
    // 删除完成通知可使旧投影失效；在操作结束后公开重读，验证最终占位。
    await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
    await expect(helper.getByRole('region', { name: '已保存的讨论', exact: true })
      .getByText('相关来源不可用', { exact: true })).toBeVisible();
    await expect(editor).toHaveCount(0);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  });
  process.stdout.write('page_test_scenario_passed: 迟到依据响应不能恢复暂存候选\n');
}
