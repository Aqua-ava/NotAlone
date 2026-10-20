import { expect, type Browser } from '@playwright/test';
import { withLayeredMemoryFixture } from '../layered-memory-fixture';
import { selectMemoryCategory } from '../memory-page-actions';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { PageHost } from './page-host';

// 移除摘要入口不删除既有本人记忆。
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
      await expect(manager.getByRole('region', { name: '我的记忆', exact: true })).toBeVisible();
      await expect(manager.getByText('查看摘要', { exact: true })).toHaveCount(0);
      await expect(manager.getByRole('region', { name: '主题资料', exact: true })).toHaveCount(0);
      await expect(manager.getByText('整理管理', { exact: true })).toHaveCount(0);
      const stored = await fixture.request('/api/memories/owner');
      expect(stored.status).toBe(200);
      expect(JSON.stringify(stored.data)).toContain(oldText);
      expect((await fixture.command('runtime_proof')).external_model_calls).toBe(0);
    } finally { await host.close(); }
  }), released, { ownerOnly: true, initiallyDisabled: true });
  process.stdout.write('page_test_scenario_passed: owner-without-summary-preserves-stored-memories\n');
}
