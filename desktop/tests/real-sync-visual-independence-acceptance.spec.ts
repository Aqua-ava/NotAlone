import { expect } from '@playwright/test';
import { stat, writeFile } from 'node:fs/promises';
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

export function wechatStageEvidence(rows: readonly Record<string, unknown>[], triggeredAt: number,
  fixedStartedAt: number | null = null) {
  const formal = rows.filter(row => row.kind === 'probe-start' || row.kind === 'probe');
  const started = new Set<number>();
  const completed = new Map<number, 'paused' | 'recognized'>();
  let invalid = !Number.isFinite(triggeredAt);
  for (const row of formal) {
    const at = row.started_at_ms;
    if (typeof at !== 'number' || !Number.isFinite(at)) { invalid = true; continue; }
    if (at < triggeredAt) continue;
    if (row.kind === 'probe-start') {
      if (started.has(at)) invalid = true;
      started.add(at);
    } else {
      if (!started.has(at) || completed.has(at)) invalid = true;
      const status = row.native_status;
      if (status !== 'paused' && status !== 'recognized') { invalid = true; continue; }
      const pair = [{ kind: 'probe-start', started_at_ms: at }, row];
      if (visualPhaseEvidence(pair, at, status === 'paused' ? 'finder' : 'wechat').invalid) invalid = true;
      completed.set(at, status);
    }
  }
  const recognized = [...completed].filter(([, status]) => status === 'recognized').map(([at]) => at);
  const firstPositive = recognized.length ? Math.min(...recognized) : null;
  let startedAt = fixedStartedAt;
  if (startedAt === null && firstPositive !== null
    && [...started].filter(at => at < firstPositive).every(at => completed.get(at) === 'paused')) {
    startedAt = firstPositive;
  }
  if (startedAt !== null && completed.get(startedAt) !== 'recognized') invalid = true;
  const waitingCompleted = [...completed].filter(([at, status]) => status === 'paused'
    && (startedAt === null || at < startedAt)).length;
  if (startedAt !== null && [...completed].some(([at, status]) => at < startedAt && status !== 'paused')) invalid = true;
  const evidence = startedAt === null ? null : visualPhaseEvidence(rows, startedAt, 'wechat');
  // 正向边界前的合法暂停另账；边界固定后仍沿用原recognized严格检查。
  if (evidence) invalid ||= evidence.invalid;
  return { startedAt, waitingCompleted, invalid, evidence,
    ready: !invalid && evidence?.ready === true };
}

type HelperStageBoundary = { triggeredAt: number; deadlineAt: number; startedAt: number | null;
  checkpoint: number | null; checkpointObservedAt: number | null };
export function helperStageEvidence(previous: HelperStageBoundary | undefined, frame: {
  triggeredAt: number; observedAt: number; checkedAt: number; auditObservedAt: number; focused: boolean;
  rows: readonly Record<string, unknown>[]; audit: readonly CliAudit[];
}) {
  let boundary: HelperStageBoundary = previous ?? { triggeredAt: frame.triggeredAt,
    deadlineAt: frame.triggeredAt + 70_000, startedAt: null, checkpoint: null, checkpointObservedAt: null };
  const expired = frame.checkedAt >= boundary.deadlineAt;
  if (boundary.startedAt === null && frame.focused && !expired) boundary = { ...boundary,
    startedAt: frame.observedAt, checkpoint: frame.audit.length, checkpointObservedAt: frame.auditObservedAt };
  const evidence = boundary.startedAt === null ? null : visualPhaseEvidence(frame.rows, boundary.startedAt, 'helper');
  return { boundary, evidence, invalid: evidence?.invalid === true, expired,
    ready: !expired && frame.focused && evidence?.ready === true && boundary.checkpoint !== null
      && completedTailAfter(frame.audit, boundary.checkpoint) };
}

export function boundaryProbeEvidence(rows: readonly Record<string, unknown>[], startedAt: number, snapshotRows: number) {
  const snapshot = rows.slice(0, snapshotRows);
  const completed = new Set(snapshot.filter(row => row.kind === 'probe').map(row => row.started_at_ms));
  const pendingBefore = snapshot.filter(row => row.kind === 'probe-start'
    && typeof row.started_at_ms === 'number' && row.started_at_ms < startedAt && !completed.has(row.started_at_ms));
  const pendingStarts = new Set(pendingBefore.map(row => row.started_at_ms));
  const completedObservedLater = rows.slice(snapshotRows).filter(row => row.kind === 'probe'
    && pendingStarts.has(row.started_at_ms));
  return { snapshotRows, pendingBefore, completedObservedLater,
    stillPending: pendingBefore.filter(row => !completedObservedLater.some(end => end.started_at_ms === row.started_at_ms)),
    completionWallClockCertified: false };
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
    const lastFocus: Partial<Record<VisualPhase, { observedAtMs: number; helperFocused: boolean; managerFocused: boolean;
      helperVisible: boolean; managerVisible: boolean; allUnfocused: boolean }>> = {};
    const rootTriggerWrittenAt: Partial<Record<VisualPhase, number>> = {};
    const phaseTriggeredAt: Partial<Record<VisualPhase, number>> = {};
    const phaseDeadlineAt: Partial<Record<VisualPhase, number>> = {};
    const firstNativeObservedAt: Partial<Record<VisualPhase, number>> = {};
    const phaseStartedAt: Partial<Record<VisualPhase, number>> = {};
    const cliCheckpoints: Partial<Record<VisualPhase, { row: number; observedAtMs: number }>> = {};
    const boundarySnapshots: Partial<Record<VisualPhase, { rows: number; observedAtMs: number }>> = {};
    let wechatWaitingCompleted = 0;
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
      return { observedAtMs: Date.now(), helperFocused: helper?.isFocused() ?? false, managerFocused: manager?.isFocused() ?? false,
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
        const triggeredAt = Date.now();
        phaseTriggeredAt[next] = triggeredAt;
        // 文件修改时刻与runner收到信号的时刻分列；二者都不代签GUI或原生条件。
        rootTriggerWrittenAt[next] = (await stat(path.join(directory, `${next}.trigger`))).mtimeMs;
        const checkpoint = next === 'finder' ? (await realSyncBackend.audit()).length : null;
        if (checkpoint !== null) {
          phaseStartedAt[next] = triggeredAt;
          cliCheckpoints[next] = { row: checkpoint, observedAtMs: Date.now() };
        }
        const deadlineAt = (next === 'finder' ? Date.now() : triggeredAt) + (next === 'wechat' ? 25_000 : 70_000);
        phaseDeadlineAt[next] = deadlineAt;
        let helperBoundary: HelperStageBoundary | undefined;
        let rejected = false;
        await expect.poll(async () => {
          await checkLease();
          const focus = await windowFocus();
          lastFocus[next] = focus;
          if (next === 'finder') {
            // Finder保持原合同：trigger起点、实际失焦、完整零采集暂停与新tail。
            if (!focus.allUnfocused) return false;
            firstNativeObservedAt[next] ??= focus.observedAtMs;
            const rows = await readObservationMeasurements(realSyncBackend);
            boundarySnapshots[next] ??= { rows: rows.length, observedAtMs: Date.now() };
            const evidence = visualPhaseEvidence(rows, triggeredAt, next);
            phases[next] = evidence;
            expect(evidence.invalid, '本阶段正式原生观察出现不合规或未知结果').toBe(false);
            return evidence.ready && completedTailAfter(await realSyncBackend.audit(), checkpoint!);
          }
          const rows = await readObservationMeasurements(realSyncBackend);
          const rowsObservedAt = Date.now();
          if (next === 'wechat') {
            const progress = wechatStageEvidence(rows, triggeredAt, phaseStartedAt[next] ?? null);
            wechatWaitingCompleted = progress.waitingCompleted;
            if (progress.evidence) phases[next] = progress.evidence;
            if (progress.invalid) { rejected = true; return true; }
            if (progress.startedAt !== null && phaseStartedAt[next] === undefined) {
              phaseStartedAt[next] = progress.startedAt;
              firstNativeObservedAt[next] = rowsObservedAt;
              boundarySnapshots[next] = { rows: rows.length, observedAtMs: rowsObservedAt };
            }
            return Date.now() < deadlineAt && focus.allUnfocused && progress.ready;
          }
          const alreadyStarted = helperBoundary?.startedAt !== null && helperBoundary?.startedAt !== undefined;
          const audit = focus.helperFocused || alreadyStarted
            ? await realSyncBackend.audit() : [];
          const auditObservedAt = Date.now();
          const progress = helperStageEvidence(helperBoundary, { triggeredAt, observedAt: focus.observedAtMs,
            checkedAt: auditObservedAt, auditObservedAt, focused: focus.helperFocused, rows, audit });
          helperBoundary = progress.boundary;
          if (helperBoundary.startedAt !== null && phaseStartedAt[next] === undefined) {
            phaseStartedAt[next] = helperBoundary.startedAt;
            firstNativeObservedAt[next] = helperBoundary.startedAt;
            cliCheckpoints[next] = { row: helperBoundary.checkpoint!, observedAtMs: helperBoundary.checkpointObservedAt! };
            boundarySnapshots[next] = { rows: rows.length, observedAtMs: rowsObservedAt };
          }
          if (progress.evidence) phases[next] = progress.evidence;
          // 已固定起点后，即使失焦仍检查零新probe，不清空或重置任何证据。
          if (progress.invalid) { rejected = true; return true; }
          if (!progress.ready) return false;
          const terminalFocus = await windowFocus();
          lastFocus[next] = terminalFocus;
          return Date.now() < deadlineAt && terminalFocus.helperFocused;
        }, { timeout: Math.max(1, deadlineAt - Date.now()), intervals: [250] }).toBe(true);
        expect(rejected, '本阶段正式原生观察出现不合规或未知结果，停止而不重设边界。').toBe(false);
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
      const measurementRows = await readObservationMeasurements(realSyncBackend);
      const boundaryInFlight = Object.fromEntries(Object.entries(boundarySnapshots).map(([phase, snapshot]) => [phase,
        boundaryProbeEvidence(measurementRows, phaseStartedAt[phase as VisualPhase]!, snapshot.rows)]));
      await writeFile(test.info().outputPath('real-sync-visual-measurements.json'), JSON.stringify({
        rootTriggerWrittenAt, phaseTriggeredAt, phaseDeadlineAt, firstNativeObservedAt, phaseStartedAt,
        cliCheckpoints, boundarySnapshots, boundaryInFlight, wechatWaitingCompleted, rows: measurementRows,
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
