import type { Browser } from '@playwright/test';
import { withSourceDeletionFixture } from '../source-deletion-fixture';
import { sourceDeletionBasic, sourceDeletionVerification, sourceDeletionUnknown, sourceDeletionArguments, sourceDeletionReplies, sourceDeletionUnrelated } from '../source-deletion-page-scenarios';
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

async function runReplySourceDeletion(browser: Browser, origin: string, scenario: typeof sourceDeletionReplies) {
  await withSourceDeletionFixture(async (fixture) => withControllerEnvironment(fixture, async (userData) => {
    const released = ownResource();
    const host = new PageHost(await browser.newContext(), origin, userData);
    try {
      await host.backend.connect();
      await scenario(await host.open('manager'), await host.open('helper'), fixture);
    } finally { await host.close(); fixture.confirmControllerStopped(); released(); }
  }), 'reply');
  process.stdout.write(`page_test_scenario_passed: ${scenario.name}\n`);
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

export async function sourceDeletionRepliesAcceptance(browser: Browser, origin: string) {
  await runReplySourceDeletion(browser, origin, sourceDeletionReplies);
}
export async function sourceDeletionUnrelatedAcceptance(browser: Browser, origin: string) {
  await runReplySourceDeletion(browser, origin, sourceDeletionUnrelated);
}
export async function sourceDeletionEvidenceFailureAcceptance(browser: Browser, origin: string) {
  await withSourceDeletionFixture(async (fixture) => {
    const released = ownResource();
    const proxy = await MemoryHttpProxy.attach(fixture.infoPath);
    try { await withControllerEnvironment(fixture, async (userData) => {
      const host = new PageHost(await browser.newContext(), origin, userData);
      try {
        await host.backend.connect();
        await sourceDeletionUnrelated(await host.open('manager'), await host.open('helper'), fixture, proxy);
      } finally { proxy.release(); await host.close(); fixture.confirmControllerStopped(); }
    }); } finally { await proxy.close(); released(); }
  }, 'reply');
  process.stdout.write('page_test_scenario_passed: source-deletion-evidence-failure\n');
}

export async function sourceDeletionMultiSourceAcceptance(browser: Browser, origin: string) {
  const { sourceDeletionMultiSource } = await import('../source-deletion-page-scenarios');
  await withSourceDeletionFixture(async (fixture) => withControllerEnvironment(fixture, async (userData) => {
    const released = ownResource();
    const host = new PageHost(await browser.newContext(), origin, userData);
    try { await host.backend.connect(); await sourceDeletionMultiSource(await host.open('manager'), fixture); }
    finally { await host.close(); fixture.confirmControllerStopped(); released(); }
  }), 'multi-source');
  process.stdout.write('page_test_scenario_passed: source-deletion-multi-source\n');
}

export async function sourceDeletionStaleRequestAcceptance(browser: Browser, origin: string) {
  const { SourceDeletionProxy } = await import('../source-deletion-proxy');
  const { sourceDeletionStaleRequest } = await import('../source-deletion-page-scenarios');
  await withSourceDeletionFixture(async (fixture) => {
    const released = ownResource();
    const proxy = await SourceDeletionProxy.attach(fixture.infoPath);
    try { await withControllerEnvironment(fixture, async (userData) => {
      const host = new PageHost(await browser.newContext(), origin, userData);
      try {
        await host.backend.connect();
        await sourceDeletionStaleRequest(await host.open('manager'), await host.open('helper'), fixture, proxy);
      } finally { proxy.release(); await host.close(); fixture.confirmControllerStopped(); }
    }); } finally { await proxy.close(); released(); }
  }, 'reply');
  process.stdout.write('page_test_scenario_passed: source-deletion-stale-request\n');
}

// 仅由受限 test:pages 调度；复用同一浏览器，十场各自完成精确库与后端收尾后再进入下一场。
export async function sourceDeletionFull(browser: Browser, origin: string) {
  const scenarios = [sourceDeletionAcceptance, sourceDeletionVerificationAcceptance,
    sourceDeletionUnknownAcceptance, sourceDeletionArgumentsAcceptance, sourceDeletionRepliesAcceptance,
    sourceDeletionCrossContactAcceptance, sourceDeletionUnrelatedAcceptance, sourceDeletionEvidenceFailureAcceptance,
    sourceDeletionMultiSourceAcceptance, sourceDeletionStaleRequestAcceptance];
  for (const scenario of scenarios) await scenario(browser, origin);
  process.stdout.write('page_test_scenarios_passed: source-deletion-full 10/10\n');
}
