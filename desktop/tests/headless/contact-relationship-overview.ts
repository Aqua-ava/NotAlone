import { expandOverviewDetails, openImportManagement, selectMemoryCategory } from '../memory-page-actions';
import { expect, type Browser } from '@playwright/test';
import { withRelationshipOverviewFixture } from '../contact-relationship-overview-fixture';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { PageHost } from './page-host';

type PreparedOverview = {
  contactId: string; otherContactId: string; sourceToDelete: string; newSourceId: string;
  old: { text: string }; current: { text: string }; manual: { text: string }; other: { text: string };
};

// 使用调度器已有的单Chrome租约；本场只开管理页，所有资料来自隔离HTTP夹具。
export async function contactRelationshipOverview(browser: Browser, origin: string) {
  const released = ownResource();
  await withRelationshipOverviewFixture(async (fixture) => withControllerEnvironment(fixture, async (userData) => {
    const prepared = await fixture.command('overview_prepared') as PreparedOverview;
    const proof = await fixture.command('runtime_proof');
    expect(proof.environment_verified).toBe(true);
    expect(proof.critical_module_count).toBe(8);
    const host = new PageHost(await browser.newContext(), origin, userData);
    try {
      await host.backend.connect();
      const manager = await host.open('manager');
      await manager.getByRole('button', { name: '选择合成事件联系人', exact: true }).click();
      await manager.getByRole('button', { name: '记忆', exact: true }).click();
      await selectMemoryCategory(manager, '联系人概览');
      const overview = manager.getByRole('region', { name: '联系人经历与关系变化', exact: true });
      const old = overview.getByRole('article').filter({ has: manager.getByText(prepared.old.text, { exact: true }) });
      const current = overview.getByRole('article').filter({ has: manager.getByText(prepared.current.text, { exact: true }) });
      const manual = overview.getByRole('article').filter({ has: manager.getByText(prepared.manual.text, { exact: true }) });
      await expect(old.getByText('事件阶段：计划（来源已核验）', { exact: true })).not.toBeVisible();
      await expandOverviewDetails(old);
      await expandOverviewDetails(current);
      await expect(old.getByText('事件阶段：计划（来源已核验）', { exact: true })).toBeVisible();
      await expect(current.getByText('事件阶段：已发生（来源已核验）', { exact: true })).toBeVisible();
      await expect(old.getByText('当前核实状态：历史资料（已过期）', { exact: true })).toBeVisible();
      await expect(current.getByText('来源聊天时间：2026年8月4日 10:00:00（UTC+8） 至 2026年8月5日 12:00:00（UTC+8）', { exact: true })).toBeVisible();
      await expect(current.getByText('事件发生时段：2026年8月5日 00:00:00（UTC+8） 至 2026年8月6日 00:00:00（UTC+8）（来源已核验）', { exact: true })).toBeVisible();
      await expandOverviewDetails(current);
      await expect(current.getByText(`来源引用：${prepared.sourceToDelete} · 导入来源`, { exact: true })).toBeVisible();
      await expect(current.getByText(`来源引用：${prepared.newSourceId} · 导入来源`, { exact: true })).toBeVisible();
      await current.getByRole('button', { name: `查看变化依据：${prepared.current.text}`, exact: true }).click();
      await expect(manager.getByRole('region', { name: '资料版本历史', exact: true }).getByText(prepared.old.text, { exact: true })).toBeVisible();
      await current.getByRole('button', { name: `查看概览依据：${prepared.current.text}`, exact: true }).click();
      const traces = manager.getByRole('region', { name: '记忆依据', exact: true });
      await expect(traces).toBeVisible();
      await expect(traces.getByRole('textbox', { name: '记录标识' })).toHaveCount(0);
      await selectMemoryCategory(manager, '联系人概览');
      await expandOverviewDetails(manual);
      await expect(manual.getByText('用户手动录入（来源为手录资料）。', { exact: true })).toBeVisible();
      await manual.getByRole('button', { name: `查看概览依据：${prepared.manual.text}`, exact: true }).click();
      await expect(traces.getByText('这条资料由手动录入，没有模型提取的聊天依据。', { exact: true })).toBeVisible();
      await selectMemoryCategory(manager, '联系人概览');
      await expect(overview.getByText(prepared.other.text, { exact: true })).toHaveCount(0);

      await selectMemoryCategory(manager, '联系人记忆');
      const contact = manager.getByRole('region', { name: '联系人记忆', exact: true });
      await contact.getByRole('button', { name: `修正资料：${prepared.current.text}`, exact: true }).click();
      const correction = contact.getByRole('form', { name: '修正联系人资料', exact: true });
      const correctedText = '已参加读书会，并保留这次合成备注。';
      await correction.getByRole('textbox', { name: '资料正文', exact: true }).fill(correctedText);
      await correction.getByRole('button', { name: '保存修正', exact: true }).click();
      await expect(contact.getByRole('button', { name: `修正资料：${correctedText}`, exact: true })).toBeVisible();
      await selectMemoryCategory(manager, '联系人概览');
      await expect(overview.getByText(correctedText, { exact: true })).toBeVisible();

      await openImportManagement(manager);
      const source = manager.getByRole('region', { name: '已导入资料', exact: true }).locator(`[data-source-id="${prepared.sourceToDelete}"]`);
      await source.getByRole('button', { name: '删除来源', exact: true }).click();
      await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
      await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
      await selectMemoryCategory(manager, '联系人概览');
      for (const text of [prepared.old.text, prepared.current.text, correctedText]) await expect(overview.getByText(text, { exact: true })).toHaveCount(0);
      await expect(overview.getByText(prepared.manual.text, { exact: true })).toBeVisible();
      await expect(overview.getByRole('button', { name: '刷新联系人概览', exact: true })).toHaveCount(0);
      await expect(overview.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
      await expect(overview.getByRole('article')).toHaveCount(1);
      await manager.getByRole('combobox', { name: '资料联系人', exact: true }).selectOption(prepared.otherContactId);
      await selectMemoryCategory(manager, '联系人概览');
      await expect(overview.getByText(prepared.other.text, { exact: true })).toBeVisible();
      await expect(overview.getByText(prepared.manual.text, { exact: true })).toHaveCount(0);
      await manager.getByRole('combobox', { name: '资料联系人', exact: true }).selectOption(prepared.contactId);
      await selectMemoryCategory(manager, '联系人概览');
      await expect(overview.getByText(prepared.manual.text, { exact: true })).toBeVisible();
      await expect(overview.getByRole('article')).toHaveCount(1);
      expect((await fixture.command('runtime_proof')).model_calls).toBe(proof.model_calls);
    } finally { await host.close(); }
  }), released);
  process.stdout.write('page_test_scenario_passed: contact-overview-history-provenance-correction-and-source-deletion\n');
}
