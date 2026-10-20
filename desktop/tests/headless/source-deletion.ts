import { expect, type Browser, type Page } from '@playwright/test';
import { withSourceDeletionFixture, type SourceDeletionFixture } from '../source-deletion-fixture';
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
    const copiedTexts: string[] = [];
    const host = new PageHost(await browser.newContext(), origin, userData, {
      copySurface: { async writeText(text) { copiedTexts.push(text); }, hideWindow() { throw new Error('来源删除校验不得收起小窗。'); } },
    });
    try {
      await host.backend.connect();
      await scenario(await host.open('manager'), await host.open('helper'), fixture);
      // 仅删除前的有效版本对照写入一次；删除后所有公开复制请求必须零新增写入。
      expect(copiedTexts).toHaveLength(1);
    } finally { await host.close(); fixture.confirmControllerStopped(); released(); }
  }), 'reply');
  process.stdout.write(`page_test_scenario_passed: ${scenario.name}\n`);
}

async function runSourceDeletionWithProxy<Proxy extends Pick<MemoryHttpProxy, 'release' | 'close'>>(
  browser: Browser, origin: string, mode: Parameters<typeof withSourceDeletionFixture>[1],
  proxyFactory: (infoPath: string) => Promise<Proxy>,
  scenario: (manager: Page, helper: Page, fixture: SourceDeletionFixture, proxy: Proxy) => Promise<void>,
) {
  await withSourceDeletionFixture(async (fixture) => {
    const released = ownResource();
    const proxy = await proxyFactory(fixture.infoPath);
    let controllerStopped = false;
    try { await withControllerEnvironment(fixture, async (userData) => {
      const copiedTexts: string[] = [];
      const host = new PageHost(await browser.newContext(), origin, userData, {
        copySurface: { async writeText(text) { copiedTexts.push(text); }, hideWindow() { throw new Error('来源删除校验不得收起小窗。'); } },
      });
      try {
        await host.backend.connect();
        await scenario(await host.open('manager'), await host.open('helper'), fixture, proxy);
        // 仅删除前的有效版本对照写入一次；删除后所有公开复制请求必须零新增写入。
        expect(copiedTexts).toHaveLength(1);
      } finally { proxy.release(); await host.close(); fixture.confirmControllerStopped(); controllerStopped = true; }
    }); } finally { await proxy.close(); if (controllerStopped) released(); }
  }, mode);
}

export async function sourceDeletionCrossContactAcceptance(browser: Browser, origin: string) {
  const { SourceDeletionProxy } = await import('../source-deletion-proxy');
  const { sourceDeletionCrossContact } = await import('../source-deletion-page-scenarios');
  await runSourceDeletionWithProxy(browser, origin, 'reply', SourceDeletionProxy.attach, sourceDeletionCrossContact);
  process.stdout.write('page_test_scenario_passed: source-deletion-cross-contact\n');
}

export async function sourceDeletionRepliesAcceptance(browser: Browser, origin: string) {
  await runReplySourceDeletion(browser, origin, sourceDeletionReplies);
}
export async function sourceDeletionUnrelatedAcceptance(browser: Browser, origin: string) {
  await runReplySourceDeletion(browser, origin, sourceDeletionUnrelated);
}
export async function sourceDeletionEvidenceFailureAcceptance(browser: Browser, origin: string) {
  await runSourceDeletionWithProxy(browser, origin, 'reply', MemoryHttpProxy.attach, sourceDeletionUnrelated);
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
  await runSourceDeletionWithProxy(browser, origin, 'reply', SourceDeletionProxy.attach, sourceDeletionStaleRequest);
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
