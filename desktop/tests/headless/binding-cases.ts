import type { Browser } from '@playwright/test';
import { PageHost } from './page-host';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { withBindingFixture, type BindingMode } from '../binding-backend-fixture';
import { ContactHttpProxy } from '../contact-http-proxy';
import { bindingInitialSelection, bindingRevokeBusy, bindingMetadataStale, bindingFinalNameStale, bindingNoChannel,
  bindingCliUnavailable, bindingNamedArguments, bindingStableContacts, bindingReconfirm, bindingReconnect,
  bindingConcurrentNew, bindingRevokeWaiting, type BindingPage } from '../binding-page-scenarios';

type Scenario = (page: BindingPage, proxy: ContactHttpProxy) => Promise<void>;
async function runScenario(browser: Browser, origin: string, name: string, scenario: Scenario, mode: BindingMode = 'ready') {
  const released = ownResource();
  await withBindingFixture('notalone-headless-binding-', mode, async (fixture) => {
    await fixture.startBackend();
    const releaseProxy = ownResource();
    const proxy = await ContactHttpProxy.attach(fixture.infoPath);
    try {
      await withControllerEnvironment(fixture, async (userData) => {
        const host = new PageHost(await browser.newContext(), origin, userData);
        try {
          await host.backend.connect();
          const manager = await host.open('manager');
          await scenario({ manager, bindingBackend: fixture,
            screenshot: (file) => manager.screenshot({ path: `artifacts/headless-pages/${file}` }).then(() => undefined),
            async openHelper() {
              const opened = manager.context().waitForEvent('page');
              await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
              const helper = await opened;
              await helper.waitForURL(`${origin}/#helper`);
              return helper;
            },
          }, proxy);
        } finally {
          proxy.release();
          try { await host.close(); fixture.confirmControllerStopped(); }
          catch (error) { fixture.recordUnconfirmedCleanup('page-host'); throw error; }
        }
      });
    } finally {
      try { await proxy.close(); releaseProxy(); }
      catch (error) { fixture.recordUnconfirmedCleanup('http-proxy'); throw error; }
    }
  }, released);
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}

export async function bindingConsent(browser: Browser, origin: string) {
  await runScenario(browser, origin, 'binding-initial-selection-and-refresh', bindingInitialSelection);
  await runScenario(browser, origin, 'binding-revoke-busy-and-explicit-retry', bindingRevokeBusy);
  await runScenario(browser, origin, 'binding-metadata-stale-and-conflict', bindingMetadataStale);
  await runScenario(browser, origin, 'binding-server-final-name-stale', bindingFinalNameStale);
  await runScenario(browser, origin, 'binding-no-owner-channel', bindingNoChannel, 'no-channel');
  await runScenario(browser, origin, 'binding-cli-unavailable-revoke-and-recovery', bindingCliUnavailable);
  await runScenario(browser, origin, 'binding-named-arguments-and-helper-role', bindingNamedArguments);
  await runScenario(browser, origin, 'binding-stable-contact-and-append', bindingStableContacts);
  await runScenario(browser, origin, 'binding-rename-disappear-revoke-reconfirm', bindingReconfirm);
  await runScenario(browser, origin, 'binding-concurrent-new-contact-stale', bindingConcurrentNew);
  await runScenario(browser, origin, 'binding-revoke-waits-and-stops-later-tails', bindingRevokeWaiting);
}
export async function bindingStale(browser: Browser, origin: string) {
  for (const failure of [false, true]) await runScenario(browser, origin, `binding-reconnect-${failure ? 'failure' : 'success'}`,
    (page, proxy) => bindingReconnect(page, proxy, failure));
}
