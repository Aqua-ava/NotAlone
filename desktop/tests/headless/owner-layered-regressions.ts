import { expect, type Browser } from '@playwright/test';
import { withLayeredMemoryFixture } from '../layered-memory-fixture';
import { expandMemoryDetails, selectMemoryCategory } from '../memory-page-actions';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { PageHost } from './page-host';

// 验证本人详情与概览删除联动，以及近期状态的整理类别。
export async function ownerLayeredRegressions(browser: Browser, origin: string) {
  const released = ownResource();
  await withLayeredMemoryFixture(async fixture => withControllerEnvironment(fixture, async userData => {
    await fixture.command('create_contact');
    const oldText = '本人旧的合成学习事实。';
    const added = await fixture.request('/api/memories/manual-owner', { text: oldText, category: 'common_fact' });
    expect(added.status).toBe(200);
    const host = new PageHost(await browser.newContext(), origin, userData);
    try {
      await host.backend.connect();
      const manager = await host.open('manager');
      await manager.getByRole('button', { name: '选择本人隔离合成联系人', exact: true }).click();
      await manager.getByRole('button', { name: '记忆', exact: true }).click();
      await selectMemoryCategory(manager, '本人记忆');
      const oldOwner = manager.getByRole('region', { name: '本人记忆', exact: true });
      await expect(oldOwner.getByText(oldText, { exact: true })).toBeVisible();
      await expandMemoryDetails(oldOwner.getByRole('article').filter({ has: manager.getByText(oldText, { exact: true }) }));
      await oldOwner.getByRole('button', { name: `查看版本历史：${oldText}`, exact: true }).click();
      await expect(manager.getByRole('region', { name: '资料版本历史', exact: true }).getByText(oldText, { exact: true })).toBeVisible();
      await selectMemoryCategory(manager, '本人概览');
      const overview = manager.getByRole('region', { name: '本人事实与偏好概览', exact: true });
      await expect(overview.getByText(oldText, { exact: true })).toBeVisible();

      await selectMemoryCategory(manager, '本人主题资料');
      const layered = manager.getByRole('region', { name: '主题资料', exact: true });
      await layered.getByRole('button', { name: '管理底层本人记忆', exact: true }).click();
      const facts = manager.getByRole('region', { name: '本人记忆', exact: true });
      await expect(facts.getByText(oldText, { exact: true })).toBeVisible();
      await facts.getByRole('button', { name: `删除资料：${oldText}`, exact: true }).click();
      await facts.getByRole('button', { name: '确认删除', exact: true }).click();
      await expect(facts.getByText('当前本人暂无可查看记忆。', { exact: true })).toBeVisible();
      await selectMemoryCategory(manager, '本人记忆');
      // 不先刷新，删除后逐条记忆和已打开历史均不得遗留旧正文。
      await expect(oldOwner.getByText(oldText, { exact: true })).toHaveCount(0);
      await expect(manager.getByRole('region', { name: '资料版本历史', exact: true }).getByText(oldText, { exact: true })).toHaveCount(0);
      await selectMemoryCategory(manager, '本人概览');
      await expect(overview.getByText(oldText, { exact: true })).toHaveCount(0);
      await overview.getByRole('button', { name: '刷新本人概览', exact: true }).click();
      await expect(overview.getByText('当前本人暂无有合法依据的事实与偏好概览资料。', { exact: true })).toBeVisible();

      const recentText = '本人近期正在准备合成阅读展示。';
      const recent = await fixture.request('/api/memories/manual-owner', { text: recentText, category: 'recent_state' });
      expect(recent.status).toBe(200);
      await selectMemoryCategory(manager, '本人主题资料');
      await layered.getByRole('checkbox', { name: /确认仅整理本人的/ }).check();
      await layered.getByRole('button', { name: '确认范围并开启', exact: true }).click();
      await expect(layered.locator('.memory-overview-entries').getByText(recentText, { exact: true })).toBeVisible({ timeout: 20000 });
      await expect(layered.getByText('合格资料 1 条 · 已覆盖 1 条 · 剩余 0 条', { exact: true })).toBeVisible();
      const current = await fixture.request('/api/memories/owner/layered-memory');
      expect(current.status).toBe(200);
      expect(current.data.layered_memory).toMatchObject({ scope_kind: 'owner', contact_id: null, eligible_count: 1, covered_count: 1, remaining_count: 0 });
      await selectMemoryCategory(manager, '本人概览');
      await overview.getByRole('button', { name: '刷新本人概览', exact: true }).click();
      await expect(overview.getByText('当前本人暂无有合法依据的事实与偏好概览资料。', { exact: true })).toBeVisible();
      await expect(overview.getByText(recentText, { exact: true })).toHaveCount(0);
      const projection = await fixture.request('/api/memories/owner/overview');
      expect(projection.status).toBe(200);
      expect(JSON.stringify(projection.data)).not.toContain(recentText);
      expect((await fixture.command('runtime_proof')).external_model_calls).toBe(0);
    } finally { await host.close(); }
  }), released, { ownerOnly: true, initiallyDisabled: true });
  process.stdout.write('page_test_scenario_passed: owner-new-entry-invalidates-old-facts-overview-history-and-recent-state-is-organized\n');
}
