import { confirmHelperContact } from '../foreground-confirmation-actions';
import type { CandidateCopySurface } from '../../src/main/candidate-copy/controller';
import { expect, type Browser } from '@playwright/test';
import { PageHost } from './page-host';
import { withControllerEnvironment, withRewriteBackend } from './backend-fixture';
import { RewriteHttpProxy } from '../rewrite-http-proxy';
import { defaultRewrite, relationshipScope, unboundRejection, idempotentRewrite, rewriteFailures, rewriteSecurity,
  prepareTransientRewrite, assertTransientRewriteCleared, type RewritePages } from '../rewrite-page-scenarios';

// 每个具名场景有独立随机库和浏览器上下文，组内串行复用一个已租约的 Chrome。
export async function withRewritePages(browser: Browser, origin: string, use: (pages: RewritePages, host: PageHost, userData: string) => Promise<void>, copySurface?: CandidateCopySurface) {
  await withRewriteBackend(async (rewriteBackend) => {
    const replyTransport = await RewriteHttpProxy.attach(rewriteBackend.infoPath);
    try { await withControllerEnvironment(rewriteBackend, async (userData) => {
      const host = new PageHost(await browser.newContext(), origin, userData, { copySurface });
      try {
        await host.backend.connect();
        const manager = await host.open('manager');
        const opened = manager.context().waitForEvent('page');
        await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
        await use({ manager, helper: await opened, rewriteBackend, replyTransport,
          screenshotPath: 'artifacts/headless-pages/rewrite-acceptance-candidates.png' }, host, userData);
      } finally { replyTransport.release(); await host.close(); }
    }); } finally { await replyTransport.close(); }
  });
}

// 仅公开具名操作 Promise，用于等待迟到请求实际结束；不窥探 React/controller 状态。
function pendingGeneration({ helper }: RewritePages) {
  return helper.evaluate(async () => {
    const state = await window.notalone.contacts.getState();
    try { await window.notalone.replies.generate({ contactId: state.selectedContactId!, scopeRevision: state.scopeRevision, newRequest: true }); return 'completed'; }
    catch { return 'rejected'; }
  });
}
async function staleContact(pages: RewritePages) {
  const { manager, helper, rewriteBackend, replyTransport } = pages;
  for (const fault of [undefined, 'timeout'] as const) {
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
    await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('甲的旧草稿。');
    await rewriteBackend.plan({ count: 1, fault, prefix: '旧联系人迟到结果' });
    replyTransport.nextReply = 'hold';
    const heldBefore = replyTransport.heldCount;
    const pending = pendingGeneration(pages);
    await expect(helper.getByRole('status').filter({ hasText: '正在等待本次生成结果' })).toBeVisible();
    await expect.poll(() => replyTransport.heldCount).toBe(heldBefore + 1);
    expect(replyTransport.results.at(-1)?.status).toBe(fault ? 504 : 200);
    await manager.getByRole('button', { name: '选择合成联系人乙', exact: true }).click();
    await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('乙的新草稿。');
    replyTransport.release();
    expect(await pending).toBe('completed');
    await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('乙的新草稿。');
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
    await expect(helper.getByRole('alert')).toHaveCount(0);
    await expect(helper.getByText('旧联系人迟到结果（说法1）。', { exact: true })).toHaveCount(0);
  }
}
async function staleConnection(pages: RewritePages) {
  const { manager, helper, rewriteBackend, replyTransport } = pages;
  for (const fault of [undefined, 'failure'] as const) {
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
    await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('旧连接甲的草稿。');
    await helper.getByRole('combobox', { name: '本次语气', exact: true }).selectOption('polite');
    await helper.getByRole('textbox', { name: '本次要求', exact: true }).fill('旧连接的要求');
    await rewriteBackend.plan({ count: 1, fault, prefix: '旧连接迟到结果' });
    replyTransport.nextReply = 'hold';
    const heldBefore = replyTransport.heldCount;
    const pending = pendingGeneration(pages);
    await expect.poll(() => replyTransport.heldCount).toBe(heldBefore + 1);
    expect(replyTransport.results.at(-1)?.status).toBe(fault ? 500 : 200);
    replyTransport.failRuntime = true;
    await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
    await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('');
    replyTransport.failRuntime = false;
    await manager.getByRole('button', { name: '重试连接', exact: true }).click();
    await manager.getByRole('button', { name: '选择合成联系人乙', exact: true }).click();
    await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('新连接乙的草稿。');
    replyTransport.release();
    expect(await pending).toBe('completed');
    await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('新连接乙的草稿。');
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
    await expect(helper.getByRole('alert')).toHaveCount(0);
    await expect(helper.getByRole('textbox', { name: '本次要求', exact: true })).toHaveValue('');
    await expect(helper.getByRole('combobox', { name: '本次语气', exact: true })).toHaveValue('original');
  }
}
async function newSession(pages: RewritePages, host: PageHost, userData: string, browser: Browser, origin: string) {
  const { manager, helper, rewriteBackend } = pages;
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await prepareTransientRewrite(helper, rewriteBackend, true);
  await host.close();
  await rewriteBackend.command('restart');
  const restarted = new PageHost(await browser.newContext(), origin, userData);
  try {
    await restarted.backend.connect();
    const nextManager = await restarted.open('manager');
    await expect(nextManager.getByText('本次联系人：未确认', { exact: true })).toBeVisible();
    await nextManager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    const nextHelper = await restarted.open('helper');
    await assertTransientRewriteCleared(nextHelper);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  } finally { await restarted.close(); }
}

export async function draftRewriteAcceptance(browser: Browser, origin: string) {
  const scenarios: Array<[string, (pages: RewritePages, host: PageHost, userData: string) => Promise<void>]> = [
    ['默认改写、等待、风险、单选编辑与原快照', defaultRewrite],
    ['关系语境限定当前联系人并清除当次输入', relationshipScope],
    ['无有效绑定与其他用户真实拒绝', unboundRejection],
    ['丢包同键恢复、编辑保留与新键生成', idempotentRewrite],
    ['真实超时失败恢复与空候选拒绝', rewriteFailures],
    ['联系人切换的迟到成功和失败失效', staleContact],
    ['断线重连的迟到成功和失败失效', staleConnection],
    ['新生产会话同 userData 不恢复临时输入', (pages, host, userData) => newSession(pages, host, userData, browser, origin)],
    ['具名参数、角色和范围拒绝', async (pages) => {
      await rewriteSecurity(pages);
      expect(await pages.helper.evaluate(async () => {
        window.location.hash = '#manager';
        try { await window.notalone.replies.getState(); return 'accepted'; }
        catch { return 'rejected'; } finally { window.location.hash = '#helper'; }
      })).toBe('rejected');
      expect(pages.replyTransport.requests).toEqual([]);
    }],
  ];
  for (const [name, scenario] of scenarios) {
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withRewritePages(browser, origin, scenario);
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}

export async function draftRewriteSession(browser: Browser, origin: string) {
  const name = '新生产会话同 userData 不恢复临时输入';
  process.stdout.write(`page_test_scenario: ${name}\n`);
  await withRewritePages(browser, origin, (pages, host, userData) => newSession(pages, host, userData, browser, origin));
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}
