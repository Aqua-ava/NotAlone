import type { Browser } from '@playwright/test';
import { PageHost } from './page-host';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { withPausedForegroundFixture } from '../foreground-backend-fixture';
import { foregroundObservationPaused, foregroundPausedWithManualDraft } from '../foreground-page-scenarios';

// 首片公开入口：真实认证HTTP/PG和生产页面；只替换外部定位probe输入。
export async function foregroundPaused(browser: Browser, origin: string): Promise<void> {
  const name = '前台新观察暂停且手选草稿保留、CLI同步独立';
  process.stdout.write(`page_test_scenario: ${name}\n`);
  const released = ownResource();
  await withPausedForegroundFixture(async (fixture) => {
    await foregroundObservationPaused(fixture);
    await withControllerEnvironment(fixture, async (userData) => {
      const host = new PageHost(await browser.newContext(), origin, userData);
      try {
        await host.backend.connect();
        const manager = await host.open('manager');
        const opened = manager.context().waitForEvent('page');
        await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
        const helper = await opened;
        await helper.waitForURL(`${origin}/#helper`);
        await foregroundPausedWithManualDraft(helper, fixture);
      } finally {
        try { await host.close(); fixture.confirmControllerStopped(); }
        catch (error) { fixture.recordUnconfirmedCleanup('page-host'); throw error; }
      }
    });
  }, released);
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}
