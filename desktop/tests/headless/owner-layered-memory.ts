import { selectMemoryCategory } from '../memory-page-actions';
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
      await selectMemoryCategory(manager, '本人记忆');
      await expect(manager.getByText('查看摘要', { exact: true })).toHaveCount(0);
      await expect(manager.getByRole('region', { name: '主题资料', exact: true })).toHaveCount(0);
      await expect(manager.getByText('整理管理', { exact: true })).toHaveCount(0);
      expect((await fixture.command('runtime_proof')).external_model_calls).toBe(0);
    } finally { await host.close(); }
  }), released, { ownerOnly: true, initiallyDisabled: true });
  process.stdout.write('page_test_scenario_passed: owner-without-contact-has-no-summary-entry\n');
}
