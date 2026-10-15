import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { selectMenu } from './app-fixture';
import { verifyAppTestLease } from './app-test-gate';
import { test, type CliAudit } from './real-sync-quit-fixture';
import { readObservationMeasurements } from './observation-measurements-fixture';
import { createAcceptanceCoordinator } from './acceptance-coordinator.mjs';

// 审计没有时间戳；阶段开始时固定行边界，必须在此后完整观察真实子进程及范围校验。
export function completedTailAfter(rows: readonly CliAudit[], checkpoint: number): boolean {
  if (!Number.isSafeInteger(checkpoint) || checkpoint < 0 || checkpoint > rows.length) return false;
  let running: number | undefined;
  let finished = false;
  for (const row of rows.slice(checkpoint)) {
    if (row.kind !== 'tail') continue;
    if (row.event === 'started') {
      running = Number.isSafeInteger(row.pid) && row.pid! > 0 ? row.pid! : undefined;
      finished = false;
    } else if (row.event === 'finished') {
      finished = running !== undefined && row.pid === running && row.returncode === 0;
    } else if (row.event === 'scope_rejected') {
      finished = false;
    } else if (row.event === 'accepted' && finished) return true;
  }
  return false;
}

type VisualPhase = 'wechat' | 'helper' | 'finder';
export function visualPhaseEvidence(rows: readonly Record<string, unknown>[], since: number, phase: VisualPhase) {
  const formal = rows.filter(row => row.kind === 'probe-start' || row.kind === 'probe');
  let invalid = !Number.isFinite(since) || formal.some(row => typeof row.started_at_ms !== 'number'
    || !Number.isFinite(row.started_at_ms));
  const fresh = formal.filter(row => (row.started_at_ms as number) >= since);
  const starts = fresh.filter(row => row.kind === 'probe-start');
  const completed = fresh.filter(row => row.kind === 'probe');
  const started = new Set(starts.map(row => row.started_at_ms));
  const ended = new Set(completed.map(row => row.started_at_ms));
  invalid ||= started.size !== starts.length || ended.size !== completed.length
    || completed.some(row => !started.has(row.started_at_ms));
  const expectedCount = phase === 'wechat' ? 1 : 0;
  invalid ||= phase === 'helper' ? fresh.length > 0 : completed.some(row =>
    row.outcome !== 'returned' || row.native_status !== (phase === 'wechat' ? 'recognized' : 'paused')
    || row.complete !== true || row.valid !== true || row.single_frame_requested !== true
    || ['capture_requests', 'capture_completions', 'frames_received', 'header_ocr_calls']
      .some(key => row[key] !== expectedCount));
  return { starts: starts.length, completed: completed.length, pending: starts.length - completed.length,
    invalid, ready: !invalid && (phase === 'helper' || starts.length > 0 && starts.length === completed.length) };
}

const enabled = process.env.NOTALONE_REAL_SYNC_VISUAL_ACCEPTANCE === '1';
test.skip(!enabled, '仅主Agent协调的当前签名包单联系人视觉与真实CLI独立验收');
test.use({ realSyncVisualObservation: enabled, trace: 'off', screenshot: 'off', video: 'off' });

test('当前签名包的正式视觉观察在助手与Finder阶段暂停，已确认联系人真实CLI继续后正常退出',
  async ({ runningApp: { app, appProcess, userData }, realSyncBackend, realSyncProxy }) => {
    const lease = await verifyAppTestLease();
    test.setTimeout(Math.max(1000, lease.until - Date.now() + 10_000));
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    expect(Boolean(realSyncBackend.visualProbePath)).toBe(true);
    const backendPid = realSyncBackend.cleanupOwnership().childPid!;
    await writeFile(test.info().outputPath('real-sync-visual-owned.json'), JSON.stringify({
      appPid: appProcess.pid, backendPid, userData, fixtureDirectory: realSyncBackend.directory,
      databaseName: realSyncBackend.data.database_name,
    }), { mode: 0o600, flag: 'wx' });
    const directory = process.env.NOTALONE_AUTOMATIC_CONTROL_DIRECTORY;
    if (!directory || !path.isAbsolute(directory)) throw new Error('缺少本轮私有协调目录。');
    const checkLease = async () => {
      await verifyAppTestLease();
      if (Date.now() >= Math.min(lease.until, realSyncBackend.scope.until * 1000) - 15_000) {
        throw new Error('本轮验收时段结束，预留自有资源收尾。');
      }
    };
    const coordinator = await createAcceptanceCoordinator({ directory, pid: appProcess.pid!, checkLease,
      isAlive: () => appProcess.exitCode === null && appProcess.signalCode === null });
    const phases: Partial<Record<VisualPhase, ReturnType<typeof visualPhaseEvidence>>> = {};
    const lastFocus: Partial<Record<VisualPhase, { helperFocused: boolean; managerFocused: boolean;
      helperVisible: boolean; managerVisible: boolean; allUnfocused: boolean }>> = {};
    const phaseStartedAt: Partial<Record<VisualPhase, number>> = {};
    const tailCompleted = { helper: false, finder: false };
    let stage: VisualPhase | 'setup' | 'quit' = 'setup';
    let passed = false;
    let normalQuit = false;
    let authenticatedStopped = false;
    let ownedProcessesGone = false;
    let newReadsAfterStop: number | null = null;
    let newFormalProbesAfterStop: number | null = null;
    let emptyContactConfirmed = false;
    let scopeRejectedRequests = 0;
    const actualStarts = (rows: readonly CliAudit[]) => rows.filter(row => row.event === 'started'
      && Number.isSafeInteger(row.pid) && row.pid! > 0);
    const windowFocus = () => app.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      const helper = windows.find(window => window.webContents.getURL().endsWith('#helper'));
      const manager = windows.find(window => window.webContents.getURL().endsWith('#manager'));
      return { helperFocused: helper?.isFocused() ?? false, managerFocused: manager?.isFocused() ?? false,
        helperVisible: helper?.isVisible() ?? false, managerVisible: manager?.isVisible() ?? false,
        allUnfocused: windows.every(window => !window.isFocused()) };
    });
    try {
      const manager = await app.firstWindow();
      await manager.getByRole('button', { name: '同步设置', exact: true }).click();
      await manager.getByRole('button', { name: '开启后台同步', exact: true }).click();
      await expect.poll(async () => actualStarts(await realSyncBackend.audit())
        .filter(row => row.kind === 'sessions_follow').length, { timeout: 15_000 }).toBeGreaterThan(0);
      await selectMenu(app, '窗口', '输入小窗');
      await expect.poll(() => app.windows().some(page => page.url().endsWith('#helper'))).toBe(true);
      const helper = app.windows().find(page => page.url().endsWith('#helper'))!;
      await helper.getByRole('button', { name: '隐藏输入小窗', exact: true }).click();
      await (await app.browserWindow(manager)).evaluate(window => window.close());

      for (const next of ['wechat', 'helper', 'finder'] as const) {
        stage = next;
        console.log(`real_sync_visual_stage: ${next}`);
        // runId信号只协调主Agent实际操作，不作为前台或联系人认证收据。
        await coordinator.waitFor(next);
        const since = Date.now();
        phaseStartedAt[next] = since;
        const checkpoint = (await realSyncBackend.audit()).length;
        await expect.poll(async () => {
          await checkLease();
          const focus = await windowFocus();
          lastFocus[next] = focus;
          // 原生激活和blur异步交接；未达要求仍在原有限窗口内等待，不能以菜单操作代签焦点。
          if (next === 'helper' ? !focus.helperFocused : !focus.allUnfocused) return false;
          const evidence = visualPhaseEvidence(await readObservationMeasurements(realSyncBackend), since, next);
          phases[next] = evidence;
          expect(evidence.invalid, '本阶段正式原生观察出现不合规或未知结果').toBe(false);
          return evidence.ready && (next === 'wechat' || completedTailAfter(await realSyncBackend.audit(), checkpoint));
        }, { timeout: next === 'wechat' ? 25_000 : 70_000, intervals: [250] }).toBe(true);
        if (next !== 'wechat') tailCompleted[next] = true;
      }

      const status = await realSyncBackend.request('/api/sync/follow-smoke/status');
      expect(status.status).toBe(200);
      expect(status.data.follow_stream_active).toBe(true);
      const contacts = status.data.contacts as Array<Record<string, unknown>>;
      expect(Array.isArray(contacts)).toBe(true);
      expect(contacts).toHaveLength(1);
      expect(contacts[0].contact_id).toBe(realSyncBackend.data.contact_ids[0]);
      expect(contacts[0].bound).toBe(true);
      expect(contacts[0].message_count).toBe(0);
      expect(contacts[0].duplicate_identities).toBe(0);
      expect((await realSyncBackend.request('/api/sync/status')).data.cli_bound_count).toBe(1);
      emptyContactConfirmed = true;
      const beforeQuit = await realSyncBackend.audit();
      // 既有guard仍可能拒绝名称解析或读取；只记录总数，不推断拒绝原因或放宽范围。
      scopeRejectedRequests = beforeQuit.filter(row => row.event === 'scope_rejected').length;
      stage = 'quit';
      await coordinator.close();
      await selectMenu(app, 'NotAlone', '退出 NotAlone');
      await expect.poll(() => appProcess.exitCode, { timeout: 15_000 }).toBe(0);
      normalQuit = true;
      expect(realSyncProxy.authenticatedRuntimeStopped).toBe(true);
      authenticatedStopped = true;
      const gone = (pid: number) => {
        try { process.kill(pid, 0); return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
      };
      await expect.poll(() => gone(backendPid), { timeout: 15_000 }).toBe(true);
      const stopped = await realSyncBackend.audit();
      const ownedCliPids = [...new Set(actualStarts(stopped).map(row => row.pid!))];
      expect(ownedCliPids.length).toBeGreaterThan(0);
      for (const pid of ownedCliPids) await expect.poll(() => gone(pid), { timeout: 15_000 }).toBe(true);
      ownedProcessesGone = true;
      const probeStartsAtStop = (await readObservationMeasurements(realSyncBackend))
        .filter(row => row.kind === 'probe-start').length;
      await new Promise(resolve => setTimeout(resolve, 5000));
      newReadsAfterStop = (await realSyncBackend.audit()).filter(row => row.event === 'started').length
        - stopped.filter(row => row.event === 'started').length;
      newFormalProbesAfterStop = (await readObservationMeasurements(realSyncBackend))
        .filter(row => row.kind === 'probe-start').length - probeStartsAtStop;
      expect(newReadsAfterStop).toBe(0);
      expect(newFormalProbesAfterStop).toBe(0);
      passed = true;
    } finally {
      await coordinator.close();
      await writeFile(test.info().outputPath('real-sync-visual-measurements.json'), JSON.stringify({
        phaseStartedAt, rows: await readObservationMeasurements(realSyncBackend),
      }), { mode: 0o600 });
      await writeFile(test.info().outputPath('real-sync-visual-results.json'), JSON.stringify({
        passed, stage, phases, lastFocus, normalQuit, authenticatedStopped, ownedProcessesGone, emptyContactConfirmed,
        newReadsAfterStop, newFormalProbesAfterStop, scopeRejectedRequests,
        formalSingleFrameMeasurementsOnly: true, auxiliaryStreamIncluded: false,
        helperTailStartedFinishedAccepted: tailCompleted.helper,
        finderTailStartedFinishedAccepted: tailCompleted.finder,
        continuousExternalFocusCertified: false, identityCertified: false,
        newMessageArrivalCertified: false, twoContactContinuityCertified: false,
        externalModelCalls: 0, externalMessagesSent: 0,
      }), { mode: 0o600 });
    }
  });
