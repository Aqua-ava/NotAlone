import type { Browser } from '@playwright/test';
import { withSourceDeletionFixture } from '../source-deletion-fixture';
import { sourceDeletionBasic } from '../source-deletion-page-scenarios';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { PageHost } from './page-host';

export async function sourceDeletionAcceptance(browser: Browser, origin: string) {
  await withSourceDeletionFixture(async (fixture) => withControllerEnvironment(fixture, async (userData) => {
    const released = ownResource();
    const host = new PageHost(await browser.newContext(), origin, userData);
    try { await host.backend.connect(); await sourceDeletionBasic(await host.open('manager'), fixture); }
    finally { await host.close(); fixture.confirmControllerStopped(); released(); }
  }));
  process.stdout.write('page_test_scenario_passed: source-deletion-basic\n');
}
