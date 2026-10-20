import { expandMemoryDetails, selectMemoryCategory } from '../memory-page-actions';
import path from 'node:path';
import { expect, type Browser, type Page } from '@playwright/test';
import { withRewritePages } from './rewrite-acceptance';

async function openMemoryPage(manager: Page) {
  await manager.getByRole('button', { name: '选择合成事件联系人', exact: true }).click();
  await manager.getByRole('button', { name: '记忆', exact: true }).click();
  await manager.getByRole('button', { name: '刷新记忆', exact: true }).click();
  await selectMemoryCategory(manager, '联系人记忆');
  return manager.getByRole('region', { name: '联系人记忆', exact: true });
}

export async function memoryEventUpdates(browser: Browser, origin: string) {
  await withRewritePages(browser, origin, async ({ manager, rewriteBackend }) => {
    const prepared = await rewriteBackend.command('memory_event_updates') as {
      old: { text: string; source_ids: string[] }; current: { text: string }; sourceToDelete: string;
    };
    const contact = await openMemoryPage(manager);
    const current = contact.getByRole('article').filter({ has: manager.getByText(prepared.current.text, { exact: true }) });
    await expect(current.getByText('自动采纳（可撤销）', { exact: true })).toBeVisible();
    await expandMemoryDetails(current);
    await current.getByRole('button', { name: `查看版本历史：${prepared.current.text}`, exact: true }).click();
    const history = manager.getByRole('region', { name: '资料版本历史', exact: true });
    await expect(history.getByText(prepared.old.text, { exact: true })).toBeVisible();
    await expect(history.getByText(`来源引用：${prepared.old.source_ids[0]}`, { exact: true }).first()).toBeVisible();
    await history.getByRole('button', { name: '撤销本次自动更新', exact: true }).click();
    await history.getByRole('button', { name: '确认撤销更新并恢复旧版', exact: true }).click();
    await expect(contact.getByText(prepared.old.text, { exact: true })).toBeVisible();
    await expect(contact.getByText(prepared.current.text, { exact: true })).toHaveCount(0);
    await expect(history).toHaveCount(0);
    await selectMemoryCategory(manager, '来源与过程');
    const source = manager.getByRole('region', { name: '来源删除管理', exact: true }).getByRole('listitem')
      .filter({ hasText: `来源标识：${prepared.sourceToDelete}` });
    await source.getByRole('button', { name: '删除来源', exact: true }).click();
    await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
    await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
    await selectMemoryCategory(manager, '联系人记忆');
    await expect(contact.getByText(prepared.old.text, { exact: true })).toHaveCount(0);
  }, undefined, path.resolve('tests/fixtures/memory-event-auto-pages.py'));
  process.stdout.write('page_test_scenario_passed: memory-event-auto-history-revert-and-source-deletion\n');

  await withRewritePages(browser, origin, async ({ manager, rewriteBackend }) => {
    const prepared = await rewriteBackend.command('memory_event_updates') as {
      old: { memory_id: string; revision: number; text: string }; pending: Array<{ text: string }>; sourceToDelete: string;
    };
    const contact = await openMemoryPage(manager);
    await expect(contact.getByText(prepared.old.text, { exact: true })).toBeVisible();
    const oldCard = contact.getByRole('article').filter({ has: manager.getByText(prepared.old.text, { exact: true }) });
    await expandMemoryDetails(oldCard);
    await expect(contact.getByText('事件阶段：计划（来源已核验）', { exact: true })).toBeVisible();
    await selectMemoryCategory(manager, '待确认候选');
    const pending = manager.getByRole('region', { name: '待确认候选', exact: true });
    const candidate = pending.getByRole('article').filter({ has: manager.getByText(prepared.pending[0].text, { exact: true }) });
    await expect(candidate.getByText('待确认 · 不是已确认事实', { exact: true })).toBeVisible();
    await expandMemoryDetails(candidate);
    await expect(candidate.getByText('事件阶段：已发生（来源已核验）', { exact: true })).toBeVisible();
    await expect(candidate.getByText('事件发生时段：2026年8月5日 09:00:00（UTC+8） 至 2026年8月5日 11:00:00（UTC+8）（来源已核验）', { exact: true })).toBeVisible();
    await expect(candidate.getByText('来源聊天时间：2026年8月5日 12:00:00（UTC+8）', { exact: true })).toBeVisible();
    const form = candidate.getByRole('form', { name: `应用候选更新：${prepared.pending[0].text}`, exact: true });
    await expect(form.getByRole('button', { name: '确认应用为新版本', exact: true })).toBeDisabled();
    const selection = form.getByRole('combobox', { name: '选择要更新的当前资料', exact: true });
    const previousVersion = `${prepared.old.memory_id}:${prepared.old.revision}`;
    await selection.selectOption(previousVersion);
    await manager.getByRole('button', { name: '刷新记忆', exact: true }).click();
    await expect(selection).toHaveValue('');
    await expect(form.getByRole('button', { name: '确认应用为新版本', exact: true })).toBeDisabled();
    await selection.selectOption(previousVersion);
    await form.getByRole('button', { name: '确认应用为新版本', exact: true }).click();
    await expect(candidate).toHaveCount(0);
    await selectMemoryCategory(manager, '联系人记忆');
    const current = contact.getByRole('article').filter({ has: manager.getByText(prepared.pending[0].text, { exact: true }) });
    await expandMemoryDetails(current);
    await expect(current.getByText('手动采纳', { exact: true })).toBeVisible();
    await expect(current.getByText('事件阶段：已发生（来源已核验）', { exact: true })).toBeVisible();
    await expandMemoryDetails(current);
    await current.getByRole('button', { name: `查看版本历史：${prepared.pending[0].text}`, exact: true }).click();
    const history = manager.getByRole('region', { name: '资料版本历史', exact: true });
    await expect(history.getByText(prepared.old.text, { exact: true })).toBeVisible();
    await expect(history.getByText('事件阶段：计划（来源已核验）', { exact: true })).toBeVisible();
    await expect(history.getByText('事件阶段：已发生（来源已核验）', { exact: true })).toBeVisible();
    await expect(history.getByRole('button', { name: '撤销本次自动更新', exact: true })).toHaveCount(0);
    await selectMemoryCategory(manager, '来源与过程');
    const source = manager.getByRole('region', { name: '来源删除管理', exact: true }).getByRole('listitem')
      .filter({ hasText: `来源标识：${prepared.sourceToDelete}` });
    await source.getByRole('button', { name: '删除来源', exact: true }).click();
    await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
    await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
    await selectMemoryCategory(manager, '联系人记忆');
    await expect(current).toHaveCount(0);
    await expect(history).toHaveCount(0);
  }, undefined, path.resolve('tests/fixtures/memory-event-manual-pages.py'));
  process.stdout.write('page_test_scenario_passed: memory-event-default-pending-manual-update-and-source-deletion\n');
}
