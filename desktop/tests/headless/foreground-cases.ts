import type { Browser, Page } from '@playwright/test';
import { PageHost } from './page-host';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { withPausedForegroundFixture, withManualForegroundFixture } from '../foreground-backend-fixture';
import type { BindingFixture } from '../binding-backend-fixture';
import { foregroundObservationPaused, foregroundPausedWithManualDraft, foregroundManualConfirmation } from '../foreground-page-scenarios';

export async function withForegroundPages(browser: Browser, origin: string, fixture: BindingFixture,
  use: (manager: Page, openHelper: () => Promise<Page>) => Promise<void>): Promise<void> {
  await withControllerEnvironment(fixture, async (userData) => {
    const host = new PageHost(await browser.newContext(), origin, userData);
    try {
      await host.backend.connect();
      const manager = await host.open('manager');
      await use(manager, async () => {
        const opened = manager.context().waitForEvent('page');
        await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
        const helper = await opened;
        await helper.waitForURL(`${origin}/#helper`);
        return helper;
      });
    } finally {
      try { await host.close(); fixture.confirmControllerStopped(); }
      catch (error) { fixture.recordUnconfirmedCleanup('page-host'); throw error; }
    }
  });
}

// 首片公开入口：真实认证HTTP/PG和生产页面；只替换外部定位probe输入。
export async function foregroundPaused(browser: Browser, origin: string): Promise<void> {
  const name = '前台新观察暂停且手选草稿保留、CLI同步独立';
  process.stdout.write(`page_test_scenario: ${name}\n`);
  const released = ownResource();
  await withPausedForegroundFixture(async (fixture) => {
    await foregroundObservationPaused(fixture);
    await withForegroundPages(browser, origin, fixture, async (_manager, openHelper) => {
      await foregroundPausedWithManualDraft(await openHelper(), fixture);
    });
  }, released);
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}

// 公开人工确认场景：仅公共HTTP、页面和合成probe，验证本次helper确认门禁。
export async function foregroundManual(browser: Browser, origin: string): Promise<void> {
  const name = '缺少定位质量时保留草稿且需本次helper确认才能生成';
  process.stdout.write(`page_test_scenario: ${name}\n`);
  const released = ownResource();
  await withManualForegroundFixture(async ({ backend, setVisible }) => {
    await foregroundObservationPaused(backend);
    await withForegroundPages(browser, origin, backend, async (manager, openHelper) => {
      await foregroundManualConfirmation(manager, openHelper, backend, setVisible);
    });
  }, released);
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}
