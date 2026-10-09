import { expect, type Page } from '@playwright/test';
import type { SourceDeletionFixture } from './source-deletion-fixture';

// 公共页面发起真实删除；最终证明来自原持久任务，不用来源标记或百分比替代。
export async function sourceDeletionBasic(manager: Page, fixture: SourceDeletionFixture) {
  const contactId = fixture.data.contact_ids[0];
  const before = await fixture.http(`/api/contacts/${contactId}/sources`);
  expect(before.status).toBe(200);
  const sourceId = (before.data.sources as { source_id: string }[])[0].source_id;
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  const source = manager.getByRole('listitem').filter({ hasText: `来源标识：${sourceId}` });
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
