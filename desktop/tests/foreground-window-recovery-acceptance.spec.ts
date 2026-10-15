import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test as bindingTest } from './binding-fixture';
import { withBindingFixture } from './binding-backend-fixture';
import { selectMenu } from './app-fixture';
import { verifyAppTestLease } from './app-test-gate';
import { createAcceptanceCoordinator } from './acceptance-coordinator.mjs';
import { openVisualAcceptance, monitorVisualAcceptance } from './visual-acceptance-window';
import { foregroundFailureReason } from '../src/shared/foreground-failure.mjs';

const test = bindingTest.extend({
 bindingBackend: async ({}, use) => {
  await verifyAppTestLease();
  const executable = process.env.NOTALONE_TEST_APP_EXECUTABLE;
  if (!executable || !path.isAbsolute(executable)) throw new Error('需要本轮正式包。');
  await withBindingFixture('notalone-window-recovery-', 'single-account', async fixture => {
   const control = process.env.NOTALONE_AUTOMATIC_CONTROL_DIRECTORY;
   if (!control || !path.isAbsolute(control)) throw new Error('缺少本轮协调目录。');
   const diagnostics = path.join(control, 'recovery.jsonl');
   await writeFile(diagnostics, '', { mode: 0o600 });
   await writeFile(path.join(fixture.directory, 'foreground_recovery_diagnostics.py'),
    await readFile(path.resolve('tests/fixtures/foreground_recovery_diagnostics.py')));
   await writeFile(path.join(fixture.directory, 'sitecustomize.py'),
    'import sys\nif sys.orig_argv[1:3] == ["-m", "notalone.server.command"]:\n    from foreground_recovery_diagnostics import install\n    install()\n');
   const environment = fixture.environment.bind(fixture);
   fixture.environment = owner => ({ ...environment(owner),
    NOTALONE_SYNC_PROBE: path.resolve(path.dirname(executable), '../Resources/notalone-probe/notalone-sync-probe'),
    NOTALONE_RECOVERY_DIAGNOSTICS: diagnostics,
    PYTHONPATH: `${fixture.directory}${path.delimiter}${environment(owner).PYTHONPATH}` });
   await fixture.setCli({ sessions: [], messages: {} });
   await fixture.startBackend();
   await use(fixture);
  });
 },
});
test.skip(process.env.NOTALONE_WINDOW_RECOVERY_ACCEPTANCE !== '1', '显式Computer Use窗口恢复验收');
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('正式修复包窗口变化与前台观察诊断', async ({ runningApp: { app, appProcess }, bindingBackend }) => {
 const lease = await verifyAppTestLease();
 test.setTimeout(Math.max(1000, lease.until - Date.now() + 10000));
 const directory = process.env.NOTALONE_AUTOMATIC_CONTROL_DIRECTORY;
 if (!directory || !path.isAbsolute(directory)) throw new Error('缺少本轮协调目录。');
 const coordinator = await createAcceptanceCoordinator({ directory, pid: appProcess.pid!,
  checkLease: verifyAppTestLease, isAlive: () => appProcess.exitCode === null && appProcess.signalCode === null });
 let stopped = false;
 let normalQuit = false;
 const samples: object[] = [];
 let monitor: Awaited<ReturnType<typeof monitorVisualAcceptance>> | undefined;
 let sampling: Promise<void> | undefined;
 let samplingFailed = false;
 let appExit: { code: number | null; signal: string | null } | null = null;
 appProcess.once('exit', (code, signal) => { appExit = { code, signal }; });
 try {
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  await selectMenu(app, '窗口', '输入小窗');
  await expect.poll(() => app.windows().some(page => page.url().endsWith('#helper'))).toBe(true);
  const helper = app.windows().find(page => page.url().endsWith('#helper'))!;
  await expect.poll(() => helper.evaluate(async () => (await window.notalone.contacts.getState()).directoryPhase)).toBe('ready');
  const viewer = await openVisualAcceptance(app);
  process.stdout.write('window_recovery_setup_ready\n');
  const names = await viewer.waitForNames();
  await bindingBackend.setCli({ sessions: names.map((name, i) => ({ username: `wxid_synthetic_${i ? 'b' : 'a'}`,
   display_name: name, chat_type: 'private', last_timestamp: 1700000000 })), messages: {} });
  expect((await bindingBackend.request('/api/sync/cli-bindings/confirm', { selections: names.map((_, i) => ({
   locator: `wxid_synthetic_${i ? 'b' : 'a'}`, contact_id: bindingBackend.data.contact_ids[i] })) })).status).toBe(200);
  await helper.evaluate(() => window.notalone.hideWindow());
  monitor = await monitorVisualAcceptance({ page: viewer.page, helper, directory,
   expectedContactId: bindingBackend.data.contact_ids[0],
   alternateContactId: names.length === 2 ? bindingBackend.data.contact_ids[1] : undefined,
   requestFinish: () => coordinator.requestFinish(), openHelper: () => selectMenu(app, '窗口', '输入小窗') });
  expect((await bindingBackend.request('/api/sync/enable', {})).status).toBe(200);
  sampling = (async () => {
   while (!stopped) {
    const sample = await helper.evaluate(async expected => {
     const state = await window.notalone.foreground.getState();
     const contacts = await window.notalone.contacts.getState();
     return { at: Date.now(), phase: state.phase, reason: state.reason,
      confirmedA: state.confirmedContactId === expected && contacts.selectedContactId === expected,
      confirmation: state.confirmation, helperFocused: state.suspendedByHelperFocus,
      draftMatches: contacts.draft === '持续跟随验收合成草稿（不发送）', draftLength: contacts.draft.length };
    }, bindingBackend.data.contact_ids[0]);
    const safe = { ...sample, reason: foregroundFailureReason(sample.reason)?.code ?? null };
    samples.push(safe);
    await writeFile(path.join(directory, 'manual-state.json'), JSON.stringify(safe), { mode: 0o600 });
    await new Promise(resolve => setTimeout(resolve, 500));
   }
  })().catch(() => { samplingFailed = true; });
  process.stdout.write('window_recovery_live_ready\n');
  await coordinator.waitFor('finish');
  stopped = true; await sampling; await monitor.stop();
  expect(samplingFailed, '正式状态采样须持续可用').toBe(false);
  await coordinator.close();
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode, { timeout: 15000 }).toBe(0);
  normalQuit = true;
 } finally {
  stopped = true; await sampling;
  await monitor?.stop(); await coordinator.close();
  const diagnostics = (await readFile(path.join(directory, 'recovery.jsonl'), 'utf8'))
   .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  await writeFile(test.info().outputPath('window-recovery-results.json'), JSON.stringify({ normalQuit, appExit, samplingFailed,
   samples, diagnostics, visualChecks: monitor?.counts ?? null, privateBodyRead: false, modelCalls: 0, sentMessages: 0 }), { mode: 0o600 });
 }
});
