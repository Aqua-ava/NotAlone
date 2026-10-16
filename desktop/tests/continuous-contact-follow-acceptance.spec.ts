import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test as bindingTest } from './binding-fixture';
import { withBindingFixture } from './binding-backend-fixture';
import { selectMenu } from './app-fixture';
import { verifyAppTestLease } from './app-test-gate';
import { createAcceptanceCoordinator } from './acceptance-coordinator.mjs';
import { openVisualAcceptance, monitorVisualAcceptance } from './visual-acceptance-window';
import { prepareObservationMeasurements, readObservationMeasurements } from './observation-measurements-fixture';

const visualAcceptance = process.env.NOTALONE_CONTINUOUS_VISUAL_ACCEPTANCE === '1';
const headerAcceptance = process.env.NOTALONE_FORMAL_HEADER_PREVIEW === '1';

// 仅正式包、真实原生名称识别；CLI正文和业务数据均为合成输入。
const test = bindingTest.extend({
  bindingBackend: async ({}, use) => {
    await verifyAppTestLease();
    const executable = process.env.NOTALONE_TEST_APP_EXECUTABLE;
    const names = [process.env.NOTALONE_FOLLOW_TEST_NAME_A, process.env.NOTALONE_FOLLOW_TEST_NAME_B].filter((name): name is string => Boolean(name?.trim()));
    if (!executable || !path.isAbsolute(executable) || (!visualAcceptance && !headerAcceptance && !process.env.NOTALONE_FOLLOW_TEST_NAME_A?.trim())
      || (visualAcceptance && names.length > 0)
      || (headerAcceptance && (visualAcceptance || names.length > 0))
      || new Set(names).size !== names.length) {
      throw new Error('缺少正式包或本轮已确认测试会话的明确范围。');
    }
    const probe = path.resolve(path.dirname(executable), '../Resources/notalone-probe/notalone-sync-probe');
    await withBindingFixture('notalone-follow-app-', 'single-account', async fixture => {
      await prepareObservationMeasurements(fixture, probe);
      await fixture.setCli({ sessions: names.map((name, index) => ({ username: `wxid_synthetic_${index ? 'b' : 'a'}`,
        display_name: name, chat_type: 'private', last_timestamp: 1700000000 })), messages: {} });
      await fixture.startBackend();
      expect(await readObservationMeasurements(fixture)).toEqual([{ kind: 'installed' }]);
      if (names.length) expect((await fixture.request('/api/sync/cli-bindings/confirm', { selections: fixture.data.contact_ids.slice(0, names.length).map((id, index) =>
        ({ locator: `wxid_synthetic_${index ? 'b' : 'a'}`, contact_id: id })) })).status).toBe(200);
      await use(fixture);
    });
  },
});
test.skip(process.env.NOTALONE_CONTINUOUS_APP_ACCEPTANCE !== '1', '须明确本轮时段、正式包和测试联系人');
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('正式App持续单帧名称跟随及可视诊断生命周期', async ({ runningApp: { app, appProcess }, bindingBackend }) => {
  const lease = await verifyAppTestLease();
  // 失败留窗不超出租约；额外时间只用于夹具回收，watchApp到期仍会关闭实例。
  test.setTimeout(Math.max(1000, lease.until - Date.now() + 10000));
  const directory = process.env.NOTALONE_AUTOMATIC_CONTROL_DIRECTORY;
  if (!directory || !path.isAbsolute(directory)) throw new Error('缺少本轮私有协调目录。');
  const reports: Array<Record<string, unknown>> = [];
  const measurements = () => readObservationMeasurements(bindingBackend);
  const appResourceSamples: Array<Record<string, number>> = [];
  const pauseIntervals: Array<{ kind: 'other-app' | 'helper'; start: number; end: number }> = [];
  const sampleResources = async () => {
    const sample = await app.evaluate(() => ({ sampledAtMs: Date.now(), rssBytes: process.memoryUsage().rss,
      cpuMicroseconds: process.cpuUsage().user + process.cpuUsage().system }));
    appResourceSamples.push(sample);
  };
  let visualMonitor: Awaited<ReturnType<typeof monitorVisualAcceptance>> | undefined;
  let headerExpiry: ReturnType<typeof setTimeout> | undefined;
  const coordinator = await createAcceptanceCoordinator({ directory, pid: appProcess.pid!,
    checkLease: verifyAppTestLease,
    isAlive: () => appProcess.exitCode === null && appProcess.signalCode === null });
  let currentStage = 'setup';
  const ready = async (phase: string) => {
    currentStage = phase;
    process.stdout.write(`continuous_ready:${phase}\n`);
    await sampleResources();
    await coordinator.waitFor(phase);
  };
  const saveReport = async () => writeFile(test.info().outputPath('continuous-follow-results.json'), JSON.stringify({ reports, normalQuit,
    visualChecks: visualMonitor?.counts ?? null,
    privateBodyRead: false, sentMessages: 0, modelCalls: 0,
    measurements: await measurements(), pauseIntervals, appMainProcessSamples: appResourceSamples }), { mode: 0o600 });
  let normalQuit = false;
  try {
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    await selectMenu(app, '窗口', '输入小窗');
    await expect.poll(() => app.windows().find(page => page.url().endsWith('#helper')) !== undefined).toBe(true);
    const helper = app.windows().find(page => page.url().endsWith('#helper'))!;
    const requireForeground = async (phase: string) => {
      await coordinator.waitForForeground(phase, async since => {
        const foreground = await helper.evaluate(() => window.notalone.foreground.getState());
        const helperBlurred = await app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('#helper'));
          return window !== undefined && !window.isFocused();
        });
        return { helperBlurred: helperBlurred && !foreground.suspendedByHelperFocus,
          wechatInFront: foreground.wechatInFront === true,
          freshObservation: Date.parse(foreground.observedAt ?? '') >= since,
          probeAvailable: foreground.probeAvailable,
          unavailable: foreground.phase === 'unavailable',
          foregroundUnknown: foreground.reason === 'foreground_application_unavailable',
          probeTimedOut: foreground.reason === 'probe_timeout' };
      });
    };
    await expect.poll(() => helper.evaluate(async () => (await window.notalone.contacts.getState()).directoryPhase)).toBe('ready');
    if (headerAcceptance) {
      // 正式助手展示原始顶部名称；本轮不预填姓名或建立身份绑定。
      expect((await bindingBackend.request('/api/sync/status')).data.sync_enabled).toBe(false);
      await expect(helper.getByRole('region', { name: '前台会话定位', exact: true })).toBeVisible();
      const pin = helper.getByRole('button', { name: '置顶输入小窗', exact: true });
      await expect(pin).toBeEnabled();
      if ((await pin.getAttribute('aria-pressed')) !== 'true') await pin.click();
      await expect(pin).toHaveAttribute('aria-pressed', 'true');
      expect((await bindingBackend.request('/api/sync/enable', {})).status).toBe(200);
      process.stdout.write('formal_header_preview_ready: 正式助手已打开，切换微信会话即可核对名称与置信度。\n');
      headerExpiry = setTimeout(() => { void coordinator.requestFinish().catch(() => {}); },
        Math.max(1, lease.until - Date.now() - 15000));
      try { await ready('finish'); }
      catch (error) { if (appProcess.exitCode !== 0) throw error; }
      await coordinator.close();
      if (appProcess.exitCode === null) {
        await selectMenu(app, 'NotAlone', '退出 NotAlone');
        await expect.poll(() => appProcess.exitCode, { timeout: 15000 }).toBe(0);
      }
      normalQuit = true;
      reports.push({ phase: 'formal-header-preview', diagnosticOnly: true,
        manualAcceptanceRequired: true, verifiedBindingTested: false });
      return;
    }
    if (visualAcceptance) {
      expect((await bindingBackend.request('/api/sync/status')).data.sync_enabled).toBe(false);
      const viewer = await openVisualAcceptance(app);
      viewer.page.once('close', () => { void coordinator.requestFinish().catch(() => {}); });
      process.stdout.write('continuous_visual_ready: waiting for user to confirm one session name in the window\n');
      const names = await viewer.waitForNames();
      await bindingBackend.setCli({ sessions: names.map((name, index) => ({ username: `wxid_synthetic_${index ? 'b' : 'a'}`,
        display_name: name, chat_type: 'private', last_timestamp: 1700000000 })), messages: {} });
      expect((await bindingBackend.request('/api/sync/cli-bindings/confirm', { selections: names.map((_, index) => ({
        locator: `wxid_synthetic_${index ? 'b' : 'a'}`, contact_id: bindingBackend.data.contact_ids[index] })) })).status).toBe(200);
      await helper.evaluate(() => window.notalone.hideWindow());
      visualMonitor = await monitorVisualAcceptance({ page: viewer.page, helper, directory,
        expectedContactId: bindingBackend.data.contact_ids[0], alternateContactId: names.length === 2 ? bindingBackend.data.contact_ids[1] : undefined,
        requestFinish: () => coordinator.requestFinish(),
        openHelper: () => selectMenu(app, '窗口', '输入小窗') });
    }
    expect((await bindingBackend.request('/api/sync/enable', {})).status).toBe(200);
    if (process.env.NOTALONE_CONTINUOUS_MANUAL_ACCEPTANCE === '1') {
      // 真人操作正式助手；只保存匿名状态，不因匹配失败提前结束或追认为自动通过。
      let stopped = false;
      let verifiedSamples = 0;
      reports.push({ phase: 'manual-review', manualAcceptanceRequired: true, automaticAcceptance: false });
      const monitor = (async () => {
        while (!stopped) {
          const sample = await helper.evaluate(async expected => {
            const foreground = await window.notalone.foreground.getState();
            const contacts = await window.notalone.contacts.getState();
            return { phase: 'manual-observation', sampledAtMs: Date.now(),
              state: foreground.phase, helperFocused: foreground.suspendedByHelperFocus,
              wechatInFront: foreground.wechatInFront,
              selectedExpected: contacts.selectedContactId === expected,
              confirmedExpected: foreground.confirmedContactId === expected,
              verifiedBinding: foreground.confirmation === 'verified-binding',
              draftPresent: Boolean(contacts.draft),
              expectedDraft: contacts.draft === '持续跟随验收合成草稿（不发送）' };
          }, bindingBackend.data.contact_ids[0]);
          reports.push(sample);
          if (sample.verifiedBinding && sample.selectedExpected && sample.confirmedExpected) verifiedSamples++;
          await writeFile(path.join(directory, 'manual-state.json'), JSON.stringify({ ...sample, verifiedSamples }), { mode: 0o600 });
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      })().catch(() => { reports.push({ phase: 'manual-monitor', monitorFailed: true }); });
      headerExpiry = setTimeout(() => { void coordinator.requestFinish().catch(() => {}); },
        Math.max(1, lease.until - Date.now() - 15000));
      try { await ready('finish'); }
      catch (error) { if (appProcess.exitCode !== 0) throw error; }
      finally { stopped = true; await monitor; }
      await coordinator.close();
      if (appProcess.exitCode === null) {
        await selectMenu(app, 'NotAlone', '退出 NotAlone');
        await expect.poll(() => appProcess.exitCode, { timeout: 15000 }).toBe(0);
      }
      normalQuit = true;
      return;
    }
    if (visualAcceptance) {
      // 此模式只持续展示正式状态；结束不再依赖某一步先匹配成功。
      await ready('finish');
      await visualMonitor!.stop();
      reports.push({ phase: 'visual-preview', diagnosticOnly: true, manualAcceptanceRequired: true,
        observedVerifiedBinding: visualMonitor!.counts.matchedSamples > 0 });
      await coordinator.close();
      await selectMenu(app, 'NotAlone', '退出 NotAlone');
      await expect.poll(() => appProcess.exitCode, { timeout: 15000 }).toBe(0);
      normalQuit = true;
      expect(visualMonitor!.counts.monitorFailed, '可视监控不得静默失败').toBe(false);
      expect(visualMonitor!.counts.mismatches, '人工核对存在不一致，保留诊断结果').toBe(0);
      return;
    }
    const phases: Array<[string, number]> = [['baseline', 0], ['moved', 0], ['resized', 0]];
    if (process.env.NOTALONE_FOLLOW_TEST_NAME_B?.trim()) phases.push(['switch-b', 1], ['return-a', 0]);
    for (const [phase, index] of phases) {
      await ready(phase);
      await requireForeground(phase);
      const started = Date.now();
      const matched = () => helper.evaluate(async ({ expected, since }) => {
        const foreground = await window.notalone.foreground.getState();
        const contacts = await window.notalone.contacts.getState();
        return { matched: contacts.selectedContactId === expected && foreground.confirmedContactId === expected
          && foreground.confirmation === 'verified-binding' && Date.parse(foreground.observedAt ?? '') >= since,
          selectedExpected: contacts.selectedContactId === expected,
          confirmedExpected: foreground.confirmedContactId === expected,
          suggestedExpected: foreground.suggestedContactId === expected,
          verifiedBinding: foreground.confirmation === 'verified-binding',
          freshObservation: Date.parse(foreground.observedAt ?? '') >= since,
          helperFocused: foreground.suspendedByHelperFocus === true,
          wechatInFront: foreground.wechatInFront === true,
          probeAvailable: foreground.probeAvailable === true,
          observing: foreground.phase === 'observing',
          manualRequired: foreground.phase === 'manual-required',
          paused: foreground.phase === 'paused',
          unavailable: foreground.phase === 'unavailable',
          observationTimeout: foreground.reason === 'observation_timeout',
          syncDisabled: foreground.reason === 'sync_disabled',
          connectionUnavailable: foreground.reason === 'connection_unavailable' };
      }, { expected: bindingBackend.data.contact_ids[index], since: started });
      // 失败也保留最后一次布尔诊断；不写入原始reason、名称、ID或原生载荷。
      let lastObservation: Awaited<ReturnType<typeof matched>> | undefined;
      let samples = 0;
      try {
        await expect.poll(async () => {
          lastObservation = await matched();
          samples += 1;
          return lastObservation.matched;
        }, { timeout: 30000 }).toBe(true);
      } catch (error) {
        reports.push({ phase, matched: false, samples, elapsedMs: Date.now() - started,
          observationSampled: lastObservation !== undefined, ...lastObservation });
        throw error;
      }
      if (lastObservation?.matched) reports.push({ phase, matched: true, displayedAfterTriggerMs: Date.now() - started });
      await writeFile(path.join(directory, `${phase}.result.json`), JSON.stringify(reports.at(-1)), { mode: 0o600, flag: 'wx' });
    }
    await ready('other-app');
    await expect.poll(async () => helper.evaluate(async () => {
      const state = await window.notalone.foreground.getState();
      return state.phase === 'paused' && state.wechatInFront === false;
    }), { timeout: 30000 }).toBe(true);
    reports.push({ phase: 'other-app', paused: true });
    const nonWechatStart = Date.now();
    await new Promise(resolve => setTimeout(resolve, 4500));
    const nonWechat = (await measurements()).filter(item => item.kind === 'probe'
      && Number(item.started_at_ms) >= nonWechatStart);
    expect(nonWechat.length, '暂停期间仍须实际观察到非微信检查').toBeGreaterThan(0);
    expect(nonWechat.every(item => item.complete === true && item.capture_requests === 0
      && item.header_ocr_calls === 0), '其他App前台不得采图或OCR').toBe(true);
    pauseIntervals.push({ kind: 'other-app', start: nonWechatStart, end: Date.now() });
    await selectMenu(app, '窗口', '输入小窗');
    if (!(await helper.getByRole('textbox', { name: '草稿', exact: true }).isEnabled())) {
      reports.push({ phase: 'helper-pause', blocked: true, draftDisabled: true });
      throw new Error('草稿尚不可编辑，不能验收输入暂停及恢复；保留前序匹配诊断。');
    }
    await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('持续跟随验收合成草稿（不发送）');
    const paused = await helper.evaluate(async () => window.notalone.foreground.getState());
    expect(paused.suspendedByHelperFocus).toBe(true);
    expect(paused.generationBlock).toBeNull();
    const helperPauseStart = Date.now();
    await new Promise(resolve => setTimeout(resolve, 4500));
    const held = await helper.evaluate(async () => window.notalone.foreground.getState());
    expect(held.foregroundRevision).toBe(paused.foregroundRevision);
    expect((await measurements()).filter(item => item.kind === 'probe-start'
      && Number(item.started_at_ms) >= helperPauseStart)).toHaveLength(0);
    pauseIntervals.push({ kind: 'helper', start: helperPauseStart, end: Date.now() });
    expect(await helper.getByRole('textbox', { name: '草稿', exact: true }).inputValue()).toBe('持续跟随验收合成草稿（不发送）');
    reports.push({ phase: 'helper-pause', noNewObservation: true, draftPreserved: true });
    await ready('resume-a');
    await requireForeground('resume-a');
    await expect.poll(async () => helper.evaluate(async expected => {
      const state = await window.notalone.foreground.getState();
      return !state.suspendedByHelperFocus && state.confirmedContactId === expected && state.phase === 'confirmed';
    }, bindingBackend.data.contact_ids[0]), { timeout: 30000 }).toBe(true);
    await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('持续跟随验收合成草稿（不发送）');
    reports.push({ phase: 'resume-a', matched: true, draftPreserved: true });
    const observed = (await measurements()).filter(item => item.kind === 'probe');
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every(item => item.valid === true && Number(item.capture_requests) <= 1
      && Number(item.frames_received) <= 1 && Number(item.header_ocr_calls) <= 1)).toBe(true);
    expect(observed.some(item => item.complete === true && item.capture_completions === 1
      && item.frames_received === 1 && item.header_ocr_calls === 1)).toBe(true);
    await ready('finish');
    expect(visualMonitor?.counts.monitorFailed ?? false, '可视验收监控不得静默失败').toBe(false);
    expect(visualMonitor?.counts.mismatches ?? 0, '人工前台核对存在不一致，不能标记整轮通过').toBe(0);
    await visualMonitor?.stop();
    await coordinator.close();
    await selectMenu(app, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => appProcess.exitCode, { timeout: 15000 }).toBe(0);
    normalQuit = true;
    const finalMeasurements = await measurements();
    const starts = finalMeasurements.filter(item => item.kind === 'probe-start');
    const ends = finalMeasurements.filter(item => item.kind === 'probe');
    expect(ends.map(item => item.started_at_ms).sort()).toEqual(starts.map(item => item.started_at_ms).sort());
    for (const interval of pauseIntervals) {
      const inInterval = (item: Record<string, unknown>) => Number(item.started_at_ms) >= interval.start
        && Number(item.started_at_ms) <= interval.end;
      if (interval.kind === 'helper') expect(starts.filter(inInterval)).toHaveLength(0);
      else expect(ends.filter(inInterval).every(item => item.complete === true
        && item.capture_requests === 0 && item.header_ocr_calls === 0)).toBe(true);
    }
    expect(reports.filter(report => report.matched === false), '实机匹配阶段不得静默跳过失败').toEqual([]);
  } catch (error) {
    reports.push({ phase: currentStage, failed: true });
    await saveReport();
    if (error instanceof Error && error.message === 'visual_acceptance_cancelled') {
      await coordinator.requestFinish();
    }
    process.stdout.write('continuous_failed_held: inspect control-state.json; finish signal or lease expiry ends inspection\n');
    await coordinator.holdFailure();
    throw error;
  } finally {
    clearTimeout(headerExpiry);
    await visualMonitor?.stop();
    await coordinator.close();
    // 只输出阶段/布尔/耗时；不输出联系人身份、名称或原生原始输出。
    await saveReport();
  }
});
