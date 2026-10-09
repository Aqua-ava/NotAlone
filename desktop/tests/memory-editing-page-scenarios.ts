import { expect, type Page } from '@playwright/test';
import type { MemoryFixture } from './memory-backend-fixture';

// 首片只核验本人资料修正；通过公开控件操作并从真实 HTTP 核对新版本。
export async function memoryOwnerCorrection(manager: Page, fixture: MemoryFixture) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  const owner = manager.getByRole('region', { name: '本人记忆', exact: true });
  await expect(owner.getByText('本人喜欢合成绿茶。', { exact: true })).toBeVisible();
  const before = await fixture.readMemorySection(fixture.data.contact_ids[0], 'owner');
  expect(before.status).toBe(200);
  const previous = (before.data.memories as Array<Record<string, unknown>>)
    .find((item) => item.text === '本人喜欢合成绿茶。')!;
  await owner.getByRole('button', { name: '修正资料：本人喜欢合成绿茶。', exact: true }).click();
  const form = owner.getByRole('form', { name: '修正本人资料', exact: true });
  await form.getByRole('textbox', { name: '资料正文', exact: true }).fill('本人改为喜欢合成白茶。');
  await form.getByRole('combobox', { name: '资料分类', exact: true }).selectOption('preference');
  await form.getByRole('button', { name: '保存修正', exact: true }).click();
  await expect(owner.getByText('本人改为喜欢合成白茶。', { exact: true })).toBeVisible();
  await expect(owner.getByText('本人喜欢合成绿茶。', { exact: true })).toHaveCount(0);
  await owner.getByRole('button', { name: '查看来源与版本：本人改为喜欢合成白茶。', exact: true }).click();
  const corrected = owner.getByRole('article').filter({ has: manager.getByText('本人改为喜欢合成白茶。', { exact: true }) });
  await expect(corrected.getByText('手动采纳', { exact: true })).toBeVisible();
  await expect(corrected.getByText('版本：2 · 当前有效', { exact: true })).toBeVisible();
  await expect(corrected.getByText(`替代版本引用：${previous.memory_id}`, { exact: true })).toBeVisible();
  const after = await fixture.readMemorySection(fixture.data.contact_ids[0], 'owner');
  expect(after.status).toBe(200);
  const memories = after.data.memories as Array<Record<string, unknown>>;
  expect(memories.some((item) => item.memory_id === previous.memory_id)).toBe(false);
  expect(memories.find((item) => item.text === '本人改为喜欢合成白茶。')).toMatchObject({
    level: 'owner', category: 'preference', adoption_method: 'manual', status: 'active', revision: 2,
    supersedes_memory_id: previous.memory_id, source_ids: previous.source_ids,
  });
}
