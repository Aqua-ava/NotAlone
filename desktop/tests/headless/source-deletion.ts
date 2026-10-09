import type { Browser } from '@playwright/test';
import { withSourceDeletionFixture } from '../source-deletion-fixture';
import { sourceDeletionBasic, sourceDeletionVerification } from '../source-deletion-page-scenarios';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { PageHost } from './page-host';

async function runSourceDeletion(browser: Browser, origin: string, scenario: typeof sourceDeletionBasic) {
  await withSourceDeletionFixture(async (fixture) => withControllerEnvironment(fixture, async (userData) => {
    const released = ownResource();
    const host = new PageHost(await browser.newContext(), origin, userData);
    try { await host.backend.connect(); await scenario(await host.open('manager'), fixture); }
    finally { await host.close(); fixture.confirmControllerStopped(); released(); }
  }));
  process.stdout.write(`page_test_scenario_passed: ${scenario.name}\n`);
}
export async function sourceDeletionAcceptance(browser: Browser, origin: string) { await runSourceDeletion(browser, origin, sourceDeletionBasic); }
export async function sourceDeletionVerificationAcceptance(browser: Browser, origin: string) { await runSourceDeletion(browser, origin, sourceDeletionVerification); }
