import { expect, type Page } from '@playwright/test';
import type { SourceDeletionFixture } from './source-deletion-fixture';
import type { MemoryHttpProxy } from './memory-http-proxy';

// 公共页面发起真实删除；最终证明来自原持久任务，不用来源标记或百分比替代。
export async function sourceDeletionBasic(manager: Page, fixture: SourceDeletionFixture) {
  const contactId = fixture.data.contact_ids[0];
  const before = await fixture.http(`/api/contacts/${contactId}/sources`);
  expect(before.status).toBe(200);
  const sourceId = (before.data.sources as { source_id: string }[])[0].source_id;
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  const source = manager.getByRole('region', { name: '来源删除管理', exact: true }).getByRole('listitem').filter({ hasText: `来源标识：${sourceId}` });
  await expect(source).toBeVisible();
  await source.getByRole('button', { name: '删除来源', exact: true }).click();
  await expect(manager.getByText('应用内删除不代表外部模型副本已删除。', { exact: true })).toBeVisible();
  await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
  await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
  const after = await fixture.http(`/api/contacts/${contactId}/sources`);
  const deleted = (after.data.sources as { source_id: string; task_id: string; status: string }[]).find((entry) => entry.source_id === sourceId)!;
  expect(deleted.status).toBe('deleted');
  const task = await fixture.http(`/api/tasks/status?contact_id=${contactId}&task_id=${deleted.task_id}`);
  expect(task.status).toBe(200);
  expect(task.data.status).toBe('succeeded');
  expect((task.data.steps as { name: string; status: string }[]).find((step) => step.name === 'verify_not_retrievable')?.status).toBe('succeeded');
  const messages = await fixture.http(`/api/contacts/${contactId}/messages`);
  expect(messages.data.messages).toEqual([]);
  const other = await fixture.http(`/api/contacts/${fixture.data.contact_ids[1]}/messages`);
  expect((other.data.messages as unknown[]).length).toBe(1);
}

export async function sourceDeletionVerification(manager: Page, fixture: SourceDeletionFixture) {
  await sourceDeletionBasic(manager, fixture);
  const contactId = fixture.data.contact_ids[0];
  const sources = await fixture.http(`/api/contacts/${contactId}/sources`);
  const deleted = (sources.data.sources as { source_id: string; task_id: string }[])[0];
  await fixture.failFinalVerification(contactId, deleted.task_id);
  await manager.getByRole('button', { name: '刷新删除状态', exact: true }).click();
  const source = manager.getByRole('region', { name: '来源删除管理', exact: true }).getByRole('listitem').filter({ hasText: `来源标识：${deleted.source_id}` });
  await expect(source.getByText('删除失败：不可检索校验，可重试原任务', { exact: true })).toBeVisible();
  await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toHaveCount(0);
  const failed = await fixture.http(`/api/tasks/status?contact_id=${contactId}&task_id=${deleted.task_id}`);
  expect(failed.data.status).toBe('failed');
  await source.getByRole('button', { name: '重试来源删除', exact: true }).click();
  await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
  await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
  const after = await fixture.http(`/api/contacts/${contactId}/sources`);
  expect((after.data.sources as { task_id: string }[])[0].task_id).toBe(deleted.task_id);
  const task = await fixture.http(`/api/tasks/status?contact_id=${contactId}&task_id=${deleted.task_id}`);
  expect(task.data.status).toBe('succeeded');
  expect((task.data.steps as { status: string }[]).every((step) => step.status === 'succeeded')).toBe(true);
}

export async function sourceDeletionUnknown(manager: Page, fixture: SourceDeletionFixture, proxy: MemoryHttpProxy) {
  const contactId = fixture.data.contact_ids[0];
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  const panel = manager.getByRole('region', { name: '来源删除管理', exact: true });
  await expect(panel.getByRole('button', { name: '删除来源', exact: true })).toBeVisible();
  proxy.failurePaths.add(`/api/contacts/${contactId}/sources`);
  await panel.getByRole('button', { name: '删除来源', exact: true }).click();
  await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('删除结果尚未确认');
  await expect(panel.getByText('已删除，已通过不可检索校验', { exact: true })).toHaveCount(0);
  expect(proxy.requests.some((request) => request.method === 'DELETE' && request.path.startsWith(`/api/contacts/${contactId}/sources/`))).toBe(true);
  proxy.failurePaths.clear();
  await panel.getByRole('button', { name: '刷新删除状态', exact: true }).click();
  await expect(panel.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
  const result = await fixture.http(`/api/contacts/${contactId}/sources`);
  const taskId = (result.data.sources as { task_id: string }[])[0].task_id;
  const task = await fixture.http(`/api/tasks/status?contact_id=${contactId}&task_id=${taskId}`);
  expect(task.data.status).toBe('succeeded');
}

export async function sourceDeletionArguments(manager: Page, helper: Page, fixture: SourceDeletionFixture, proxy: MemoryHttpProxy) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  await expect(manager.getByRole('region', { name: '来源删除管理', exact: true }).getByRole('button', { name: '删除来源', exact: true })).toBeVisible();
  const state = await manager.evaluate(() => window.notalone.sources.getState());
  const request = { contactId: state.contactId!, scopeRevision: state.scopeRevision, sourceId: state.sources[0].sourceId };
  const before = proxy.requests.filter((request) => request.method === 'DELETE').length;
  const outcomes = await manager.evaluate(async ({ request, otherContact }) => {
    const invoke = window.notalone.sources.delete as (...args: unknown[]) => Promise<unknown>;
    const results: string[] = [];
    for (const args of [[request, 'extra'], [{ ...request, ownerId: 'renderer-owner' }], [{ ...request, scopeRevision: -1 }],
      [{ ...request, contactId: otherContact }], [{ ...request, sourceId: otherContact }], [{ ...request, sourceId: '../../source' }]]) {
      try { await invoke(...args); results.push('accepted'); } catch { results.push('rejected'); }
    }
    return results;
  }, { request, otherContact: fixture.data.other_contact_id });
  expect(outcomes).toEqual(Array(6).fill('rejected'));
  expect(await helper.evaluate(async (request) => {
    try { await window.notalone.sources.delete(request); return 'accepted'; } catch { return 'rejected'; }
  }, request)).toBe('rejected');
  expect(proxy.requests.filter((request) => request.method === 'DELETE').length).toBe(before);
  const source = await fixture.http(`/api/contacts/${request.contactId}/sources`);
  expect((source.data.sources as { status: string }[])[0].status).toBe('active');
}

export async function sourceDeletionReplies(manager: Page, helper: Page, fixture: SourceDeletionFixture) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('说明本人喜欢合成绿茶。');
  await helper.getByRole('checkbox', { name: '结合关系语境', exact: true }).check();
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
  await expect(editor).toHaveValue('来源引用合成候选。', { timeout: 15_000 });
  await editor.fill('本人资料引用的本轮编辑稿。');
  await helper.getByRole('button', { name: '展开候选1依据', exact: true }).click();
  const evidence = helper.getByRole('region', { name: '候选1依据', exact: true });
  await expect(evidence.getByText('本人喜欢合成绿茶。', { exact: true })).toBeVisible();
  const state = await helper.evaluate(() => window.notalone.replies.getState());
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  const sourcePanel = manager.getByRole('region', { name: '来源删除管理', exact: true });
  await sourcePanel.getByRole('button', { name: '删除来源', exact: true }).click();
  await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
  await expect(sourcePanel.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
  // 两窗不得继续保留被删来源支持的候选、编辑和已展开正文；不推断供应商副本。
  await expect(editor).toHaveCount(0);
  await expect(evidence).toHaveCount(0);
  await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('说明本人喜欢合成绿茶。');
  await expect(helper.getByRole('button', { name: '复制', exact: true })).toBeDisabled();
  const gone = await fixture.http(`/api/contacts/${state.contactId}/replies/${state.result!.replyRequestId}/evidence`);
  expect(gone.status).toBe(404);
  await expect(manager.getByText('本人喜欢合成绿茶。', { exact: true })).toHaveCount(0);
}

export async function sourceDeletionCrossContact(manager: Page, helper: Page, fixture: SourceDeletionFixture,
  proxy: import('./source-deletion-proxy').SourceDeletionProxy) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  const panel = manager.getByRole('region', { name: '来源删除管理', exact: true });
  await expect(panel.getByRole('button', { name: '删除来源', exact: true })).toBeVisible();
  const source = await manager.evaluate(() => window.notalone.sources.getState());
  proxy.holdDelete = true;
  await panel.getByRole('button', { name: '删除来源', exact: true }).click();
  await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
  await expect.poll(() => proxy.heldCount, { timeout: 1500 }).toBe(1);
  await manager.getByRole('combobox', { name: '资料联系人', exact: true }).selectOption(fixture.data.contact_ids[1]);
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('说明本人喜欢合成绿茶。');
  await helper.getByRole('checkbox', { name: '结合关系语境', exact: true }).check();
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
  await expect(editor).toHaveValue('来源引用合成候选。', { timeout: 2500 });
  await helper.getByRole('button', { name: '展开候选1依据', exact: true }).click();
  await expect(helper.getByRole('region', { name: '候选1依据', exact: true }).getByText('本人喜欢合成绿茶。', { exact: true })).toBeVisible({ timeout: 1500 });
  const reply = await helper.evaluate(() => window.notalone.replies.getState());
  proxy.release();
  await expect.poll(async () => {
    const response = await fixture.http(`/api/contacts/${source.contactId}/sources`);
    const taskId = (response.data.sources as { task_id: string | null }[])[0].task_id;
    if (!taskId) return 'missing';
    const task = await fixture.http(`/api/tasks/status?contact_id=${source.contactId}&task_id=${taskId}`);
    return task.data.status;
  }, { timeout: 15_000 }).toBe('succeeded');
  expect((await fixture.http(`/api/contacts/${reply.contactId}/replies/${reply.result!.replyRequestId}/evidence`)).status).toBe(404);
  await expect(editor).toHaveCount(0);
  await expect(helper.getByRole('region', { name: '候选1依据', exact: true })).toHaveCount(0);
  await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('说明本人喜欢合成绿茶。');
  await expect(helper.getByRole('button', { name: '复制', exact: true })).toBeDisabled();
}
