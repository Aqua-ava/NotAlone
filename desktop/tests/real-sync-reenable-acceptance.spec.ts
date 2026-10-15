import { expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { selectMenu } from './app-fixture';
import { verifyAppTestLease } from './app-test-gate';
import { test, type CliAudit } from './real-sync-quit-fixture';

test.skip(process.env.NOTALONE_REAL_SYNC_REENABLE_ACCEPTANCE !== '1', '仅主Agent协调的单联系人同App总开关重开验收');
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

const starts = (rows: readonly CliAudit[]) => rows.filter(row => row.event === 'started'
  && Number.isSafeInteger(row.pid) && row.pid! > 0);
const unexpectedRejection = (row: CliAudit & { code?: string }) => row.event === 'scope_rejected'
  && !(row.kind === 'sessions' && row.code === 'acceptance_session_listing_blocked');
function completedTailAfter(rows: readonly CliAudit[], checkpoint: number): boolean {
  let pid: number | undefined;
  let finished = false;
  for (const row of rows.slice(checkpoint)) {
    if (row.kind !== 'tail') continue;
    if (row.event === 'started') {
      pid = Number.isSafeInteger(row.pid) && row.pid! > 0 ? row.pid! : undefined;
      finished = false;
    } else if (row.event === 'finished') finished = pid !== undefined && row.pid === pid && row.returncode === 0;
    else if (row.event === 'scope_rejected') finished = false;
    else if (row.event === 'accepted' && finished) return true;
  }
  return false;
}
function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
}

test('当前签名包单联系人关闭总开关后零新读取，重新开启作有界补齐并保持去重计数',
  async ({ runningApp: { app, appProcess, userData }, realSyncBackend, realSyncProxy }) => {
    const lease = await verifyAppTestLease();
    const until = Math.min(lease.until, realSyncBackend.scope.until * 1000);
    const scope = realSyncBackend.scope as typeof realSyncBackend.scope & { allow_incoming_test_text?: boolean; long_running?: boolean };
    if (!Number.isFinite(scope.not_before) || !Number.isFinite(scope.until)
      || Date.now() < scope.not_before * 1000 || scope.until - scope.not_before > 480
      || scope.allow_incoming_test_text === true || scope.long_running === true
      || until - Date.now() < 240_000 || Date.now() - scope.not_before * 1000 > 120_000
      || ['NOTALONE_REAL_SYNC_VISUAL_ACCEPTANCE', 'NOTALONE_REAL_FOREGROUND_LOCATOR_ACCEPTANCE',
        'NOTALONE_TEST_FOREGROUND_CREDENTIAL', 'NOTALONE_REAL_FOREGROUND_MODE', 'NOTALONE_REAL_FOREGROUND_TARGET',
        'NOTALONE_REAL_FOREGROUND_TARGET_SHA256', 'NOTALONE_REAL_SYNC_QUIT_ACCEPTANCE'].some(key => Boolean(process.env[key]))) {
      throw new Error('重开验收须本轮新基线、独立非视觉范围并保留有限收尾时间。');
    }
    test.setTimeout(Math.min(420_000, until - Date.now() - 15_000));
    const checkWindow = () => {
      if (Date.now() >= until - 30_000) throw new Error('本轮重开验收到期，保留自有资源收尾。');
    };
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    expect(realSyncBackend.foreground).toBeUndefined();
    expect(realSyncBackend.visualProbePath).toBeUndefined();
    const backendPid = realSyncBackend.cleanupOwnership().childPid!;
    const archive = await app.evaluate(({ app }) => app.getAppPath());
    const digest = async () => createHash('sha256').update(await readFile(archive)).digest('hex');
    const initialDigest = await digest();
    await writeFile(test.info().outputPath('real-sync-reenable-owned.json'), JSON.stringify({
      appPid: appProcess.pid, backendPid, userData, fixtureDirectory: realSyncBackend.directory,
      databaseName: realSyncBackend.data.database_name,
    }), { mode: 0o600, flag: 'wx' });
    type Snapshot = { messageCount: number; observationReferences: number; duplicateIdentities: number; watermark: unknown };
    const snapshot = async (): Promise<Snapshot> => {
      const response = await realSyncBackend.request('/api/sync/follow-smoke/status');
      expect(response.status).toBe(200);
      const contacts = response.data.contacts as Array<Record<string, unknown>>;
      expect(contacts).toHaveLength(1);
      expect(contacts[0].contact_id).toBe(realSyncBackend.data.contact_ids[0]);
      expect(contacts[0].bound).toBe(true);
      expect(contacts[0].message_count).toBe(0);
      expect(contacts[0].observation_ref_count).toBe(0);
      expect(contacts[0].duplicate_identities).toBe(0);
      return { messageCount: contacts[0].message_count as number,
        observationReferences: contacts[0].observation_ref_count as number,
        duplicateIdentities: contacts[0].duplicate_identities as number, watermark: contacts[0].watermark };
    };
    const complete = async () => {
      // accepted由适配层先记审计；等待正式cycle发布状态，避免把写库前的瞬时快照当失败。
      await expect.poll(async () => {
        checkWindow();
        const response = await realSyncBackend.request('/api/sync/status');
        expect(response.status).toBe(200);
        return response.data;
      }, { timeout: 15_000, intervals: [250] }).toMatchObject({ sync_enabled: true, cli_bound_count: 1, cli_stream_active: true,
        cli_backfill_phase: 'complete', cli_backfill_total_contacts: 1, cli_backfill_completed_contacts: 1,
        cli_backfill_failed_contacts: 0, cli_backfill_incomplete_contacts: 0, cli_backfill_pending_contacts: 0,
        cli_backfill_failure_code: null, cli_backfill_total_message_count: 0 });
    };
    const waitTail = async (checkpoint: number) => {
      await expect.poll(async () => {
        checkWindow();
        const rows = await realSyncBackend.audit();
        expect(rows.some(unexpectedRejection)).toBe(false);
        return completedTailAfter(rows, checkpoint);
      }, { timeout: 70_000, intervals: [250] }).toBe(true);
    };
    let stage = 'initial-enable';
    const result: Record<string, unknown> = { passed: false, packaged: true, singleConfirmedContact: true,
      sameAppAndBackend: false, emptyWindowVerified: false, positiveGapRecoveryCertified: false,
      newIncomingMessageCertified: false, noLossCertified: false, twoContactContinuityCertified: false,
      applicationRestartCertified: false, ocrRun: false, modelCalls: 0, sentMessages: 0 };
    try {
      const manager = await app.firstWindow();
      await manager.getByRole('button', { name: '同步设置', exact: true }).click();
      const background = manager.getByRole('region', { name: '后台 CLI 同步', exact: true });
      const checkpoint = (await realSyncBackend.audit()).length;
      await background.getByRole('button', { name: '开启后台同步', exact: true }).click();
      await expect(background.getByText('后台正文同步已开启', { exact: true })).toBeVisible();
      await waitTail(checkpoint); await complete();
      const before = await snapshot();
      result.initialMessageCount = before.messageCount;
      result.initialObservationReferences = before.observationReferences;
      result.initialDuplicateIdentities = before.duplicateIdentities;

      stage = 'disabled';
      const previousStreams = starts(await realSyncBackend.audit()).filter(row => row.kind === 'sessions_follow').map(row => row.pid!);
      expect(previousStreams.length).toBeGreaterThan(0);
      await background.getByRole('button', { name: '关闭后台同步', exact: true }).click();
      await expect(background.getByText('后台正文同步已关闭', { exact: true })).toBeVisible();
      const stoppedRows = await realSyncBackend.audit();
      const previouslyStarted = starts(stoppedRows);
      const disabledStarts = previouslyStarted.length;
      const disabledSince = Date.now();
      const previousChildren = [...new Set(previouslyStarted.map(row => row.pid!))];
      const inFlight = previouslyStarted.filter(row => !gone(row.pid!));
      result.cliStartsAtDisableAcknowledgement = disabledStarts;
      result.inFlightTailCountAtDisableAcknowledgement = inFlight.filter(row => row.kind === 'tail').length;
      result.inFlightStreamCountAtDisableAcknowledgement = inFlight.filter(row => row.kind === 'sessions_follow').length;
      for (const pid of previousChildren) await expect.poll(() => gone(pid), { timeout: 15_000 }).toBe(true);
      expect((await realSyncBackend.request('/api/sync/status')).data).toMatchObject({ sync_enabled: false, cli_stream_active: false });
      // 原fixture为60秒心跳；覆盖一次完整间隔，不能以一次瞬间快照证明关闭停读。
      await expect.poll(async () => {
        checkWindow();
        const rows = await realSyncBackend.audit();
        result.cliStartsWhileDisabled = starts(rows).length - disabledStarts;
        expect(starts(rows)).toHaveLength(disabledStarts);
        expect(rows.some(unexpectedRejection)).toBe(false);
        expect((await realSyncBackend.request('/api/sync/status')).data).toMatchObject({ sync_enabled: false, cli_stream_active: false });
        expect(await snapshot()).toEqual(before);
        return Date.now() - disabledSince >= 65_000;
      }, { timeout: 70_000, intervals: [1000] }).toBe(true);
      result.disabledWindowMs = Date.now() - disabledSince;
      result.cliStartsAtDisabledWindowEnd = starts(await realSyncBackend.audit()).length;
      result.cliStartsWhileDisabled = Number(result.cliStartsAtDisabledWindowEnd) - disabledStarts;
      expect(result.cliStartsWhileDisabled).toBe(0);
      result.watermarkUnchangedWhileDisabled = true;

      stage = 'reenabled';
      const reenableCheckpoint = (await realSyncBackend.audit()).length;
      await background.getByRole('button', { name: '开启后台同步', exact: true }).click();
      await expect(background.getByText('后台正文同步已开启', { exact: true })).toBeVisible();
      await waitTail(reenableCheckpoint); await complete();
      await expect(manager.getByRole('region', { name: '历史补齐', exact: true })
        .getByText('补齐已完成', { exact: true })).toBeVisible();
      expect(await snapshot()).toEqual(before);
      const reopenedStreams = starts(await realSyncBackend.audit()).filter(row => row.kind === 'sessions_follow').map(row => row.pid!);
      expect(reopenedStreams.some(pid => !previousStreams.includes(pid))).toBe(true);
      result.reenableTailAccepted = true;
      result.backfillComplete = true;

      stage = 'natural-recheck';
      const naturalCheckpoint = (await realSyncBackend.audit()).length;
      await waitTail(naturalCheckpoint);
      await complete();
      const after = await snapshot();
      expect(after).toEqual(before);
      expect(gone(backendPid)).toBe(false);
      expect(appProcess.exitCode).toBeNull();
      result.sameAppAndBackend = true;
      result.emptyWindowVerified = true;
      result.finalMessageCount = after.messageCount;
      result.finalObservationReferences = after.observationReferences;
      result.finalDuplicateIdentities = after.duplicateIdentities;
      result.watermarkUnchangedAfterReenable = true;
      result.actualTailStarts = starts(await realSyncBackend.audit()).filter(row => row.kind === 'tail').length;

      stage = 'quit';
      await selectMenu(app, 'NotAlone', '退出 NotAlone');
      await expect.poll(() => appProcess.exitCode, { timeout: 15_000 }).toBe(0);
      expect(realSyncProxy.authenticatedRuntimeStopped).toBe(true);
      await expect.poll(() => gone(backendPid), { timeout: 15_000 }).toBe(true);
      const stopped = await realSyncBackend.audit();
      const ownPids = [...new Set(starts(stopped).map(row => row.pid!))];
      for (const pid of ownPids) await expect.poll(() => gone(pid), { timeout: 15_000 }).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 5000));
      const final = await realSyncBackend.audit();
      expect(starts(final)).toHaveLength(starts(stopped).length);
      expect(final.some(unexpectedRejection)).toBe(false);
      expect(await digest()).toBe(initialDigest);
      Object.assign(result, { passed: true, normalQuit: true, authenticatedStopped: true, ownedProcessesGone: true,
        cliStartsAtQuit: starts(stopped).length, cliStartsAfterQuit: starts(final).length,
        cliStartsFiveSecondsAfterQuit: starts(final).length - starts(stopped).length,
        appArchiveUnchanged: true, appArchiveSha256: initialDigest });
      stage = 'complete';
    } finally {
      await writeFile(test.info().outputPath('real-sync-reenable-results.json'), JSON.stringify({ ...result, stage }),
        { mode: 0o600, flag: 'wx' });
    }
  });
