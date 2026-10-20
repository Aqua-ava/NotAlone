import { expandMemorySection, selectMemoryCategory } from '../memory-page-actions';
import { expect, type Browser } from '@playwright/test';
import { withLayeredMemoryFixture } from '../layered-memory-fixture';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { PageHost } from './page-host';

// 真实 HTTP/PG 与当前 React、生产控制器；仅模型边界使用合成受控提案。
export async function ownerLayeredMemory(browser: Browser, origin: string) {
  const released = ownResource();
  await withLayeredMemoryFixture(async fixture => withControllerEnvironment(fixture, async userData => {
    const host = new PageHost(await browser.newContext(), origin, userData);
    try {
      expect(fixture.data.contact_ids).toEqual([]);
      await host.backend.connect();
      const manager = await host.open('manager');
      await manager.getByRole('button', { name: '记忆', exact: true }).click();
      await selectMemoryCategory(manager, '本人主题资料');
      await expandMemorySection(manager, '＋ 补充一条');
      await manager.getByLabel('本人资料内容', { exact: true }).fill('本人喜欢合成读书活动。');
      await manager.getByRole('button', { name: '保存本人资料', exact: true }).click();
      await expect(manager.getByText('本人资料已保存，请核对整理状态。', { exact: true })).toBeVisible();
      const panel = manager.getByRole('region', { name: '主题资料', exact: true });
      const profile = panel.getByRole('region', { name: '长期背景', exact: true });
      await panel.getByRole('checkbox', { name: /确认仅整理本人的/ }).check();
      await panel.getByRole('button', { name: '确认范围并开启', exact: true }).click();
      await expect(panel.locator('.memory-overview-entries').getByText('本人喜欢合成读书活动。', { exact: true })).toBeVisible({ timeout: 20000 });
      await expect(profile.getByText('本人喜欢合成读书活动。', { exact: true })).toBeVisible({ timeout: 20000 });
      const endpoint = '/api/memories/owner/layered-memory';
      const initial = await fixture.request(endpoint);
      expect(initial.status).toBe(200);
      expect(initial.data.layered_memory).toMatchObject({ scope_kind: 'owner', contact_id: null, enabled: true });
      await panel.getByRole('button', { name: '撤回本版主题资料：合成学习记录', exact: true }).click();
      await expect(panel.locator('.memory-overview-entries .memory-text')).toHaveCount(0);
      await expect(profile.getByText('暂无可展示的长期背景。', { exact: true })).toBeVisible();
      await panel.getByRole('button', { name: '更新状态', exact: true }).click();
      await expect(panel.locator('.memory-overview-entries .memory-text')).toHaveCount(0);
      await panel.getByRole('button', { name: '停用', exact: true }).click();
      await panel.getByRole('button', { name: '删除整理结果', exact: true }).click();
      await panel.getByRole('button', { name: '确认删除整理结果', exact: true }).click();
      await expect(panel.getByText('本范围已关闭', { exact: false })).toBeVisible();
      const final = await fixture.request(endpoint);
      expect(final.data.layered_memory).toMatchObject({ enabled: false, scenarios: [], profile: null });
      await panel.getByRole('button', { name: '管理底层本人记忆', exact: true }).click();
      const facts = manager.getByRole('region', { name: '我的记忆', exact: true });
      await expect(facts.getByText('本人喜欢合成读书活动。', { exact: true })).toBeVisible();
      await facts.getByRole('button', { name: '修正本人记忆', exact: true }).click();
      await facts.getByRole('textbox', { name: '修正本人记忆内容', exact: true }).fill('本人偏好合成阅读练习。');
      await facts.getByRole('button', { name: '保存本人记忆修正', exact: true }).click();
      await expect(facts.getByText('本人偏好合成阅读练习。', { exact: true })).toBeVisible();
      await facts.getByRole('button', { name: '删除本人记忆', exact: true }).click();
      await facts.getByRole('button', { name: '确认删除本人记忆', exact: true }).click();
      await expect(facts.getByText('还没有记住关于你的事。', { exact: true })).toBeVisible();
      const proof = await fixture.command('runtime_proof');
      expect(proof.external_model_calls).toBe(0);
      expect(proof.proposal_calls).toBeGreaterThan(0);
      expect(proof.profile_proposal_calls).toBeGreaterThan(0);
    } finally { await host.close(); }
  }), released, { ownerOnly: true, initiallyDisabled: true });
  process.stdout.write('page_test_scenario_passed: owner-layered-no-contact-manual-entry-two-layers-withdraw-disable-delete\n');
}
