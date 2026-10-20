import type { Browser, Page } from '@playwright/test';
import { PageHost } from './page-host';
import { withControllerEnvironment, withMemoryBackend } from './backend-fixture';
import { ownResource } from './cleanup';
import { MemoryHttpProxy } from '../memory-http-proxy';
import type { MemoryFixture } from '../memory-backend-fixture';
import { memoryAllEmpty, memoryDetails, memoryIndependentFailures, memoryNamedArguments, memoryPagination,
  memoryNewestRefresh, memoryOwnerScopeStale, memoryReconnect, memoryScopeAndEmpty, memoryScopeRoundTrip, memorySectionFailure } from '../memory-page-scenarios';

type Scenario = (page: Page, fixture: MemoryFixture, proxy: MemoryHttpProxy) => Promise<void>;

// 每个场景使用独立上下文、合成库与真实 HTTP；同一 CLI 的唯一浏览器串行复用。
async function runScenario(browser: Browser, origin: string, name: string, scenario: Scenario, emptyOwnerMemory = false) {
  await withMemoryBackend(async (fixture) => {
    const released = ownResource();
    const proxy = await MemoryHttpProxy.attach(fixture.infoPath);
    try {
      await withControllerEnvironment(fixture, async (userData) => {
        const host = new PageHost(await browser.newContext(), origin, userData);
        try {
          await host.backend.connect();
          await scenario(await host.open('manager'), fixture, proxy);
        } finally { proxy.release(); await host.close(); }
      });
    } finally { await proxy.close(); released(); }
  }, emptyOwnerMemory);
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}

export async function memoryReadingFull(browser: Browser, origin: string) {
  await runScenario(browser, origin, 'memory-details-and-http-scope', memoryDetails);
  await runScenario(browser, origin, 'memory-category-pagination-and-scope-reset', memoryPagination);
  await runScenario(browser, origin, 'memory-contact-switch-and-empty', memoryScopeAndEmpty);
  await runScenario(browser, origin, 'memory-named-arguments-and-source-role', memoryNamedArguments);
  await runScenario(browser, origin, 'memory-independent-retries', memoryIndependentFailures);
  for (const section of ['contact', 'owner', 'pending', 'sources'] as const) {
    await runScenario(browser, origin, `memory-${section}-loading-error-retry`, (page, fixture, proxy) => memorySectionFailure(page, fixture, proxy, section));
  }
  await runScenario(browser, origin, 'memory-four-real-empty-sections', memoryAllEmpty, true);
}

export async function memoryStaleFull(browser: Browser, origin: string) {
  for (const failure of [false, true]) {
    const outcome = failure ? 'failure' : 'success';
    await runScenario(browser, origin, `memory-owner-scope-stale-${outcome}`, (page, fixture, proxy) => memoryOwnerScopeStale(page, fixture, proxy, failure));
    await runScenario(browser, origin, `memory-newest-refresh-${outcome}`, (page, fixture, proxy) => memoryNewestRefresh(page, fixture, proxy, failure));
    await runScenario(browser, origin, `memory-scope-round-trip-${outcome}`, (page, fixture, proxy) => memoryScopeRoundTrip(page, fixture, proxy, failure));
    await runScenario(browser, origin, `memory-reconnect-${outcome}`, (page, fixture, proxy) => memoryReconnect(page, fixture, proxy, failure));
  }
}
