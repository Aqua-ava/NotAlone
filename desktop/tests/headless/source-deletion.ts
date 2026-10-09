import type { Browser } from '@playwright/test';
import { withSourceDeletionFixture } from '../source-deletion-fixture';
import { sourceDeletionBasic, sourceDeletionVerification, sourceDeletionUnknown, sourceDeletionArguments, sourceDeletionReplies } from '../source-deletion-page-scenarios';
import { MemoryHttpProxy } from '../memory-http-proxy';
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

async function runProxySourceDeletion(browser: Browser, origin: string, argumentsCase: boolean) {
  await withSourceDeletionFixture(async (fixture) => {
    const released = ownResource();
    const proxy = await MemoryHttpProxy.attach(fixture.infoPath);
    try { await withControllerEnvironment(fixture, async (userData) => {
      const host = new PageHost(await browser.newContext(), origin, userData);
      try {
        await host.backend.connect(); const manager = await host.open('manager');
        if (argumentsCase) await sourceDeletionArguments(manager, await host.open('helper'), fixture, proxy);
        else await sourceDeletionUnknown(manager, fixture, proxy);
      } finally { proxy.release(); await host.close(); fixture.confirmControllerStopped(); }
    }); } finally { await proxy.close(); released(); }
  });
  process.stdout.write(`page_test_scenario_passed: source-deletion-${argumentsCase ? 'arguments' : 'unknown'}\n`);
}
export async function sourceDeletionUnknownAcceptance(browser: Browser, origin: string) { await runProxySourceDeletion(browser, origin, false); }
export async function sourceDeletionArgumentsAcceptance(browser: Browser, origin: string) { await runProxySourceDeletion(browser, origin, true); }

export async function sourceDeletionRepliesAcceptance(browser: Browser, origin: string) {
  await withSourceDeletionFixture(async (fixture) => withControllerEnvironment(fixture, async (userData) => {
    const released = ownResource();
    const host = new PageHost(await browser.newContext(), origin, userData);
    try {
      await host.backend.connect();
      await sourceDeletionReplies(await host.open('manager'), await host.open('helper'), fixture);
    } finally { await host.close(); fixture.confirmControllerStopped(); released(); }
  }), 'reply');
  process.stdout.write('page_test_scenario_passed: source-deletion-replies\n');
}

export async function sourceDeletionCrossContactAcceptance(browser: Browser, origin: string) {
  const { SourceDeletionProxy } = await import('../source-deletion-proxy');
  const { sourceDeletionCrossContact } = await import('../source-deletion-page-scenarios');
  await withSourceDeletionFixture(async (fixture) => {
    const released = ownResource();
    const proxy = await SourceDeletionProxy.attach(fixture.infoPath);
    try { await withControllerEnvironment(fixture, async (userData) => {
      const host = new PageHost(await browser.newContext(), origin, userData);
      try {
        await host.backend.connect();
        await sourceDeletionCrossContact(await host.open('manager'), await host.open('helper'), fixture, proxy);
      } finally { proxy.release(); await host.close(); fixture.confirmControllerStopped(); }
    }); } finally { await proxy.close(); released(); }
  }, 'reply');
  process.stdout.write('page_test_scenario_passed: source-deletion-cross-contact\n');
}
