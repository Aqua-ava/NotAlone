import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test as bindingTest } from './binding-fixture';
import { withBindingFixture, initialCliState } from './binding-backend-fixture';
import { selectMenu } from './app-fixture';
import { resolveSyncProbePath } from '../src/main/backend/bundled-helpers';

// 真实签名App/HTTP/PG/窗口OCR；会话元数据与正文适配器只用隔离合成资料。
const test = bindingTest.extend({
  bindingBackend: async ({}, use) => {
    const executable = process.env.NOTALONE_TEST_APP_EXECUTABLE;
    const name = process.env.NOTALONE_TEST_SESSION_NAME;
    if (!executable || !name) throw new Error('缺少本轮签名App或已确认测试会话');
    const resources = path.join(path.dirname(path.dirname(executable)), 'Resources');
    const probe = await resolveSyncProbePath(resources);
    if (!probe) throw new Error('本轮包内探针完整性未通过');
    await withBindingFixture('notalone-native-foreground-', 'ready', async fixture => {
      const baseEnvironment = fixture.environment.bind(fixture);
      fixture.environment = owner => ({ ...baseEnvironment(owner), NOTALONE_SYNC_PROBE: probe });
      const state = initialCliState(); state.sessions[0].display_name = name;
      await fixture.setCli(state);
      await fixture.startBackend();
      await use(fixture);
    });
  },
});
test.skip(process.env.NOTALONE_NATIVE_FOREGROUND_INTEGRATION !== '1', '主Agent限定实机时段和测试会话后执行');
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('正式App使用真实OCR匹配隔离绑定并记录响应', async ({ runningApp: { app, appProcess, userData }, bindingBackend, bindingProxy }) => {
  test.setTimeout(600_000);
  const control = process.env.NOTALONE_AUTOMATIC_CONTROL_DIRECTORY;
  if (!control || !path.isAbsolute(control)) throw new Error('缺少本轮协调目录');
  const contact = bindingBackend.data.contact_ids[0];
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  await writeFile(path.join(control, 'owned.json'), JSON.stringify({ appPid: appProcess.pid, userData,
    backend: bindingBackend.cleanupOwnership() }), { mode: 0o600 });
  const manager = await app.firstWindow();
  await expect(manager.getByRole('status').filter({ hasText: '已连接' })).toBeVisible({ timeout: 20_000 });
  expect((await bindingBackend.request('/api/sync/cli-bindings/confirm', {
    selections: [{ locator: 'wxid_synthetic_a', contact_id: contact }],
  })).status).toBe(200);
  expect((await bindingBackend.request('/api/sync/enable', {})).status).toBe(200);
  bindingProxy.observeForeground(contact);
  // 启动管理页会取得焦点；隐藏测试App后留出时间回到已确认微信会话。
  await app.evaluate(({ app }) => app.hide());
  process.stdout.write('native_integration_ready: 请将已确认测试私聊置于前台，等待本轮公开菜单打开小窗。\n');
  await expect.poll(() => readFile(path.join(control, 'observe.trigger'), 'utf8').then(v => v === 'ready').catch(() => false),
    { timeout: 300_000 }).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 5000));
  const started = performance.now();
  await selectMenu(app, '窗口', '输入小窗');
  await expect.poll(() => app.windows().filter(page => page.url().endsWith('#helper')).length).toBe(1);
  const helper = app.windows().find(page => page.url().endsWith('#helper'))!;
  await helper.waitForLoadState('domcontentloaded');
  await expect.poll(() => helper.evaluate(async () => (await window.notalone.foreground.getState()).phase)).not.toBe('observing');
  const report = await helper.evaluate(async expected => {
    const state = await window.notalone.foreground.getState();
    const selection = await window.notalone.contacts.getState();
    return { phase: state.phase, reason: state.reason, confirmation: state.confirmation,
      expectedSelected: selection.selectedContactId === expected, expectedConfirmed: state.confirmedContactId === expected,
      blocked: state.generationBlock !== null, focusPaused: state.suspendedByHelperFocus };
  }, contact);
  const result = { ...report, menuToResultMs: Math.round(performance.now() - started), observations: bindingProxy.foregroundReport(),
    metadataSynthetic: true, realProbeConfigured: true, sentMessages: 0 };
  await writeFile(path.join(control, 'result.json'), JSON.stringify(result), { mode: 0o600 });
  process.stdout.write(`native_integration_result:${JSON.stringify(result)}\n`);
  expect(report).toMatchObject({ phase: 'confirmed', confirmation: 'verified-binding', expectedSelected: true,
    expectedConfirmed: true, blocked: false });
  expect(result.observations).toMatchObject({ requests: 1, received: 1, invalid: false,
    observations: [{ phase: 'confirmed', reason: 'confirmed_active_binding', wechatInFront: true,
      probeAvailable: true, expectedContactMatched: true, hasBinding: true }] });
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode, { timeout: 15_000 }).toBe(0);
});
