import type { Browser } from '@playwright/test';
import { withBindingFixture } from '../binding-backend-fixture';
import { syncSwitchStopsReading } from '../sync-page-scenarios';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { PageHost } from './page-host';

// 复用已验证的合成CLI／真实后端归属与认证收尾，不复制建库或停读逻辑。
export async function syncSwitch(browser: Browser, origin: string): Promise<void> {
  const released = ownResource();
  await withBindingFixture('notalone-headless-sync-', 'ready', async (fixture) => {
    await fixture.startBackend();
    await withControllerEnvironment(fixture, async (userData) => {
      const host = new PageHost(await browser.newContext(), origin, userData);
      try {
        await host.backend.connect();
        await syncSwitchStopsReading({ manager: await host.open('manager'), syncBackend: fixture });
      } finally {
        try { await host.close(); fixture.confirmControllerStopped(); }
        catch (error) { fixture.recordUnconfirmedCleanup('page-host'); throw error; }
      }
    });
  }, released);
  process.stdout.write('page_test_scenario_passed: sync-switch-stops-reading\n');
}
