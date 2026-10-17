import { expect, type Browser } from '@playwright/test';
import { withOwnerFactsOverviewFixture } from '../owner-facts-overview-fixture';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { PageHost } from './page-host';

type PreparedOwnerOverview = {
  contactId: string; otherContactId: string; sourceToDelete: string; otherSourceId: string;
  self: { text: string }; otherSelf: { text: string }; manualFact: { text: string }; manualPreference: { text: string };
  privateContactText: string; excludedText: string;
};

// 本票仅在已有有限调度器的单Chrome管理页中执行，资料来自自有HTTP/PG。
export async function ownerFactsOverview(browser: Browser, origin: string) {
  const released = ownResource();
  await withOwnerFactsOverviewFixture(async (fixture) => withControllerEnvironment(fixture, async (userData) => {
    const prepared = await fixture.command('owner_overview_prepared') as PreparedOwnerOverview;
    const proof = await fixture.command('runtime_proof');
    expect(proof.environment_verified).toBe(true); expect(proof.critical_module_count).toBe(9);
    const host = new PageHost(await browser.newContext(), origin, userData);
    try {
      await host.backend.connect();
      const manager = await host.open('manager');
      await manager.getByRole('button', { name: '关系资料', exact: true }).click();
      await manager.getByRole('combobox', { name: '资料联系人', exact: true }).selectOption(prepared.contactId);
      const overview = manager.getByRole('region', { name: '本人事实与偏好概览', exact: true });
      const self = overview.getByRole('article').filter({ has: manager.getByText(prepared.self.text, { exact: true }) });
      const otherSelf = overview.getByRole('article').filter({ has: manager.getByText(prepared.otherSelf.text, { exact: true }) });
      const manual = overview.getByRole('article').filter({ has: manager.getByText(prepared.manualFact.text, { exact: true }) });
      await expect(overview.getByRole('article')).toHaveCount(4);
      await expect(overview.getByText(prepared.privateContactText, { exact: true })).toHaveCount(0);
      await expect(overview.getByText(prepared.excludedText, { exact: true })).toHaveCount(0);
      await self.getByText('查看逐项来源与修订', { exact: true }).click();
      await expect(self.getByText(`来源引用：${prepared.sourceToDelete} · 导入来源`, { exact: true })).toBeVisible();
      await expect(self.getByText(`原来源联系人标识：${prepared.contactId}。请先明确选择该联系人，再核对其来源与消息。`, { exact: true })).toBeVisible();
      await expect(otherSelf.getByRole('button', { name: `查看本人概览提取过程：${prepared.otherSelf.text}`, exact: true })).toHaveCount(0);
      await self.getByRole('button', { name: `查看本人变化依据：${prepared.self.text}`, exact: true }).click();
      await expect(manager.getByRole('region', { name: '资料版本历史', exact: true }).getByText(prepared.self.text, { exact: true })).toBeVisible();
      await self.getByRole('button', { name: `查看本人概览提取过程：${prepared.self.text}`, exact: true }).click();
      await expect(manager.getByRole('region', { name: '提取与来源处理过程', exact: true }).getByText('这条资料没有已保存的过程记录。', { exact: true })).toBeVisible();
      await manual.getByText('查看逐项来源与修订', { exact: true }).click();
      await expect(manual.getByText('用户手动录入（来源为手录资料）。', { exact: true })).toBeVisible();

      const owner = manager.getByRole('region', { name: '本人记忆', exact: true });
      await owner.getByRole('button', { name: `修正资料：${prepared.self.text}`, exact: true }).click();
      const correction = owner.getByRole('form', { name: '修正本人资料', exact: true });
      const correctedText = '本人明确更正为合成凉茶。';
      await correction.getByRole('textbox', { name: '资料正文', exact: true }).fill(correctedText);
      await correction.getByRole('button', { name: '保存修正', exact: true }).click();
      await expect(owner.getByRole('button', { name: `修正资料：${correctedText}`, exact: true })).toBeVisible();
      await expect(overview.getByText(correctedText, { exact: true })).toBeVisible();

      const sources = manager.getByRole('region', { name: '来源删除管理', exact: true });
      await expect(sources.getByText(`来源标识：${prepared.otherSourceId}`, { exact: true })).toHaveCount(0);
      const source = sources.getByRole('listitem').filter({ hasText: `来源标识：${prepared.sourceToDelete}` });
      await source.getByRole('button', { name: '删除来源', exact: true }).click();
      await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
      await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(overview.getByText(prepared.self.text, { exact: true })).toHaveCount(0);
      await expect(overview.getByText(correctedText, { exact: true })).toHaveCount(0);
      await expect(overview.getByRole('article')).toHaveCount(3);
      await expect(overview.getByText(prepared.manualFact.text, { exact: true })).toBeVisible();
      await expect(overview.getByText(prepared.otherSelf.text, { exact: true })).toBeVisible();
      await overview.getByRole('button', { name: '刷新本人概览', exact: true }).click();
      await expect(overview.getByRole('article')).toHaveCount(3);

      await owner.getByRole('button', { name: `删除资料：${prepared.manualPreference.text}`, exact: true }).click();
      await owner.getByRole('button', { name: '确认删除', exact: true }).click();
      await expect(overview.getByText(prepared.manualPreference.text, { exact: true })).toHaveCount(0);
      await expect(overview.getByRole('article')).toHaveCount(2);
      await manager.getByRole('combobox', { name: '资料联系人', exact: true }).selectOption(prepared.otherContactId);
      await expect(overview.getByRole('article')).toHaveCount(2);
      await expect(sources.getByText(`来源标识：${prepared.otherSourceId}`, { exact: true })).toBeVisible();
      await expect(overview.getByRole('button', { name: `查看本人概览提取过程：${prepared.otherSelf.text}`, exact: true })).toBeVisible();
      await expect(overview.getByText(correctedText, { exact: true })).toHaveCount(0);
      expect((await fixture.command('runtime_proof')).model_calls).toBe(proof.model_calls);
    } finally { await host.close(); }
  }), released);
  process.stdout.write('page_test_scenario_passed: owner-overview-self-provenance-correction-deletion-and-explicit-source-scope\n');
}
