import { expect } from '@playwright/test';
import { test } from './memory-fixture';

// 公开 App 用例已准备；当前没有桌面验收时段，不运行，也不记为 red/green。
test('按已选联系人显示真实有效资料、本人共享资料与未确认候选', async ({ runningApp: { app }, memoryBackend }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  const contact = manager.getByRole('region', { name: '联系人记忆' });
  const owner = manager.getByRole('region', { name: '本人记忆' });
  const pending = manager.getByRole('region', { name: '待确认候选' });
  await expect(contact.getByText('甲喜欢合成茉莉茶。', { exact: true })).toBeVisible();
  await expect(contact.getByText('自动采纳（可撤销）', { exact: true })).toBeVisible();
  await expect(contact.getByText('甲的新版本关系备注。', { exact: true })).toBeVisible();
  await expect(contact.getByText('手动采纳', { exact: true })).toBeVisible();
  await expect(contact.getByText('旧版关系备注。', { exact: true })).toHaveCount(0);
  await expect(contact.getByText('甲已过期的合成状态。', { exact: true })).toHaveCount(0);
  await expect(contact.getByText('甲尚未生效的合成状态。', { exact: true })).toHaveCount(0);
  await expect(owner.getByText('本人喜欢合成绿茶。', { exact: true })).toBeVisible();
  await expect(owner.getByText('另一用户的本人资料。', { exact: true })).toHaveCount(0);
  await expect(pending.getByText('待确认 · 不是已确认事实', { exact: true })).toHaveCount(3);
  await expect(pending.getByText('主体：本人', { exact: true })).toBeVisible();
  await expect(pending.getByText('主体：联系人', { exact: true })).toBeVisible();
  await expect(pending.getByText('主体：双方', { exact: true })).toBeVisible();
  await contact.getByRole('button', { name: '查看来源与版本：甲喜欢合成茉莉茶。' }).click();
  await expect(contact.getByText('来源聊天时间：2024年1月2日 10:00:00（UTC+8）', { exact: true })).toBeVisible();
  await expect(contact.getByText('保存时间：2026年1月2日 10:00:00（UTC+8）', { exact: true })).toBeVisible();
  await expect(contact.getByText(`来源引用：${memoryBackend.data.direct_message_id}`, { exact: true })).toBeVisible();
  await expect(contact.getByText('引用类型或来源详情暂不可用。', { exact: true })).toBeVisible();
  await contact.getByRole('button', { name: '查看来源与版本：甲的新版本关系备注。' }).click();
  await expect(contact.getByText(`替代版本引用：${memoryBackend.data.supersedes_memory_id}`, { exact: true })).toBeVisible();
  await expect(contact.getByText('当前联系人来源：synthetic.jsonl · 有效', { exact: true })).toBeVisible();
  await owner.getByRole('button', { name: '查看来源与版本：本人喜欢合成绿茶。' }).click();
  await expect(owner.getByText(`来源候选引用：${memoryBackend.data.owner_candidate_id}`, { exact: true })).toBeVisible();
  await owner.getByRole('button', { name: '查看来源与版本：本人手动录入的合成资料。' }).click();
  await expect(owner.getByText('来源聊天时间：未知（来源时间不完整）', { exact: true })).toBeVisible();
  await expect(pending.getByText(/来源时间不完整/)).toHaveCount(3);
});

test('空资料明确可见，切换不显示上一位联系人的资料，本人资料仍按本人共享', async ({ runningApp: { app }, memoryBackend }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  await expect(manager.getByRole('region', { name: '资料范围未确认' })).toBeVisible();
  await expect(manager.getByText('甲喜欢合成茉莉茶。', { exact: true })).toHaveCount(0);
  await manager.getByRole('combobox', { name: '资料联系人' }).selectOption(memoryBackend.data.contact_ids[0]);
  await expect(manager.getByText('甲喜欢合成茉莉茶。', { exact: true })).toBeVisible();
  await manager.getByRole('combobox', { name: '资料联系人' }).selectOption(memoryBackend.data.contact_ids[1]);
  await expect(manager.getByText('乙喜欢合成乌龙茶。', { exact: true })).toBeVisible();
  await expect(manager.getByText('甲喜欢合成茉莉茶。', { exact: true })).toHaveCount(0);
  await expect(manager.getByText('本人喜欢合成绿茶。', { exact: true })).toBeVisible();
  await manager.getByRole('combobox', { name: '资料联系人' }).selectOption(memoryBackend.data.empty_contact_id);
  await expect(manager.getByText('这位联系人暂无当前有效记忆。', { exact: true })).toBeVisible();
  await expect(manager.getByText('这位联系人暂无待确认候选。', { exact: true })).toBeVisible();
  await expect(manager.getByText('这位联系人暂无来源记录。', { exact: true })).toBeVisible();
  await expect(manager.getByText('本人喜欢合成绿茶。', { exact: true })).toBeVisible();
  await expect(manager.getByRole('alert')).toHaveCount(0);
});

test('具名读取拒绝目录外、旧范围和多余参数，渲染层没有通用请求或认证信息', async ({ runningApp: { app }, memoryBackend }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  const rejected = await manager.evaluate(async (outsideContactId) => {
    const current = await window.notalone.contacts.getState();
    const invalid = [
      { contactId: outsideContactId, scopeRevision: current.scopeRevision },
      { contactId: current.selectedContactId!, scopeRevision: current.scopeRevision - 1 },
      { contactId: current.selectedContactId!, scopeRevision: current.scopeRevision, ownerId: outsideContactId },
      { contactId: current.selectedContactId!, scopeRevision: current.scopeRevision, section: 'http' },
    ];
    return Promise.all(invalid.map(async (request) => {
      try { await window.notalone.memory.refresh(request as Parameters<typeof window.notalone.memory.refresh>[0]); return false; }
      catch { return true; }
    }));
  }, memoryBackend.data.other_contact_id);
  expect(rejected).toEqual([true, true, true, true]);
  expect(await manager.evaluate(() => Object.keys(window.notalone.memory).sort())).toEqual(['getState', 'onStateChanged', 'refresh']);
  await expect(manager.getByText('甲喜欢合成茉莉茶。', { exact: true })).toBeVisible();
  await expect(manager.getByText('另一用户的联系人资料。', { exact: true })).toHaveCount(0);
});
