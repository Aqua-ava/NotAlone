import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { selectMenu } from './app-fixture';
import { test, type CliAudit } from './real-sync-quit-fixture';
import { confirmShortcutFeedback } from './native-shortcut-coordination';

test.skip(process.env.NOTALONE_REAL_SYNC_QUIT_ACCEPTANCE !== '1', '仅由主Agent在已确认单联系人有限时段验收');

test('最终签名包在微信非前台时保持真实CLI读取，正常退出后停止读取',
  async ({ runningApp: { app, appProcess, userData }, realSyncBackend, realSyncProxy }) => {
    test.setTimeout(240_000);
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const backendPid = realSyncBackend.cleanupOwnership().childPid!;
    await writeFile(test.info().outputPath('owned-runtime.json'), JSON.stringify({
      appPid: appProcess.pid, backendPid, userData, fixtureDirectory: realSyncBackend.directory,
      databaseName: realSyncBackend.data.database_name,
    }), { mode: 0o600 });
    const manager = await app.firstWindow();
    await manager.getByRole('button', { name: '同步设置', exact: true }).click();
    await manager.getByRole('button', { name: '开启后台同步', exact: true }).click();
    const starts = (audit: CliAudit[], kind: string) => audit.filter((row) => row.event === 'started' && row.kind === kind && Number.isInteger(row.pid));
    await expect.poll(async () => (await realSyncBackend.audit()).filter((row) => row.event === 'finished' && row.kind === 'tail' && row.returncode === 0).length, { timeout: 70_000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await realSyncBackend.audit()).filter((row) => row.event === 'accepted' && row.kind === 'tail').length, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect.poll(async () => starts(await realSyncBackend.audit(), 'sessions_follow').length, { timeout: 15_000 }).toBeGreaterThan(0);
    // 独立Agent实际置前空白Finder；程序失焦本身不能证明微信不在前台。
    await confirmShortcutFeedback('external-focus', 'agent', async (timeout) => {
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((window) => !window.isFocused())), { timeout }).toBe(true);
    }, Math.min(Date.now() + 90_000, realSyncBackend.scope.until * 1000));
    const afterExternalIndex = (await realSyncBackend.audit()).length;
    // 不发立即检查；等待正式后台线程在Finder前台期间再次完成真实有界读取。
    await expect.poll(async () => {
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((window) => !window.isFocused()))).toBe(true);
      const rows = (await realSyncBackend.audit()).slice(afterExternalIndex);
      const started = rows.findIndex((row) => row.event === 'started' && row.kind === 'tail' && Number.isInteger(row.pid));
      return started >= 0 && rows.slice(started + 1).some((row) => row.event === 'accepted' && row.kind === 'tail');
    }, { timeout: 70_000 }).toBe(true);
    await writeFile(test.info().outputPath('read-after-external-observed.json'), JSON.stringify({
      afterExternalIndex, actualReadStartedAndCompletedAfterReceipt: true,
      notAloneWindowsUnfocusedAtReadChecks: true, userConfirmationRecorded: false,
    }), { mode: 0o600, flag: 'wx' });
    const status = await realSyncBackend.request('/api/sync/follow-smoke/status');
    expect(status.status).toBe(200);
    expect(status.data.follow_stream_active).toBe(true);
    expect((await realSyncBackend.request('/api/sync/status')).data.cli_bound_count).toBe(1);
    const before = await realSyncBackend.audit();
    const unexpectedRejection = (row: CliAudit & { code?: string }) => row.event === 'scope_rejected'
      && !(row.kind === 'sessions' && row.code === 'acceptance_session_listing_blocked');
    expect(before.some(unexpectedRejection)).toBe(false);
    await selectMenu(app, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => appProcess.exitCode, { timeout: 15_000 }).toBe(0);
    expect(realSyncProxy.authenticatedRuntimeStopped).toBe(true);
    await expect.poll(() => {
      try { process.kill(backendPid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
    }, { timeout: 15_000 }).toBe(true);
    const stopped = await realSyncBackend.audit();
    const stoppedStarts = stopped.filter((row) => row.event === 'started' && Number.isInteger(row.pid)).length;
    const children = stopped.filter((row) => row.event === 'started' && row.pid).map((row) => row.pid!);
    for (const pid of children) {
      try { process.kill(pid, 0); throw new Error('本轮自有CLI进程仍存活。'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    // 退出后只读本轮最小计数，避免回读已关闭HTTP或再次唤起App。
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const after = await realSyncBackend.audit();
    expect(after.filter((row) => row.event === 'started' && Number.isInteger(row.pid)).length).toBe(stoppedStarts);
    expect(after.some(unexpectedRejection)).toBe(false);
    await writeFile(test.info().outputPath('real-sync-results.json'), JSON.stringify({
      packaged: true, uniqueConfirmedContact: true, realCliTailCompleted: true,
      globalStreamActiveBeforeQuit: true, externalFinderForegroundConfirmedByAgent: true,
      automaticReadStartedAndCompletedAfterExternalReceipt: true,
      notAloneWindowsUnfocusedAtReadChecks: true, continuousExternalAppFocusCertified: false,
      blockedSessionListingRequests: after.filter((row: CliAudit & { code?: string }) => row.event === 'scope_rejected' && row.kind === 'sessions' && row.code === 'acceptance_session_listing_blocked').length,
      normalQuit: true, authenticatedStopped: true, backendGone: true, ownedCliGone: true,
      readsAtConfirmedStop: stoppedStarts, readsAfterConfirmedStop: stoppedStarts,
      actualCliStarts: starts(after, 'tail').length, globalStreamStarts: starts(after, 'sessions_follow').length,
      newMessageArrivalCertified: false, twoContactContinuityCertified: false, sessionListingCertified: false,
      ocrRun: false, modelCalls: 0,
    }), { mode: 0o600 });
  });

// 与外部前台验收分项记录；本项不认证微信非前台或持续焦点。
test('最终签名包真实同步入库后正常退出，认证停读且五秒内无新读取',
  async ({ runningApp: { app, appProcess, userData }, realSyncBackend, realSyncProxy }) => {
    test.setTimeout(120_000);
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const backendPid = realSyncBackend.cleanupOwnership().childPid!;
    await writeFile(test.info().outputPath('owned-runtime.json'), JSON.stringify({
      appPid: appProcess.pid, backendPid, userData, fixtureDirectory: realSyncBackend.directory,
      databaseName: realSyncBackend.data.database_name,
    }), { mode: 0o600 });
    const manager = await app.firstWindow();
    await manager.getByRole('button', { name: '同步设置', exact: true }).click();
    await manager.getByRole('button', { name: '开启后台同步', exact: true }).click();
    await expect.poll(async () => (await realSyncBackend.audit()).filter((row) =>
      row.event === 'accepted' && row.kind === 'tail').length, { timeout: 70_000 }).toBeGreaterThanOrEqual(2);
    let snapshot: Record<string, unknown> | undefined;
    await expect.poll(async () => {
      const result = await realSyncBackend.request('/api/sync/follow-smoke/status');
      expect(result.status).toBe(200);
      expect(result.data.follow_stream_active).toBe(true);
      if (!Array.isArray(result.data.contacts)) throw new Error('同步计数快照形状不符合契约。');
      expect(result.data.contacts).toHaveLength(1);
      const contact = result.data.contacts[0];
      expect(contact.contact_id).toBe(realSyncBackend.data.contact_ids[0]);
      expect(contact.bound).toBe(true);
      expect(contact.duplicate_identities).toBe(0);
      snapshot = {
        messageCount: contact.message_count, observationReferenceCount: contact.observation_ref_count,
        duplicateIdentities: contact.duplicate_identities, latestMode: contact.latest_mode,
      };
      return contact.message_count;
    }, { timeout: 15_000 }).toBe(1);
    expect((await realSyncBackend.request('/api/sync/status')).data.cli_bound_count).toBe(1);
    await writeFile(test.info().outputPath('real-sync-before-quit.json'), JSON.stringify(snapshot), { mode: 0o600 });
    await selectMenu(app, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => appProcess.exitCode, { timeout: 15_000 }).toBe(0);
    expect(realSyncProxy.authenticatedRuntimeStopped).toBe(true);
    await expect.poll(() => {
      try { process.kill(backendPid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
    }, { timeout: 15_000 }).toBe(true);
    const stopped = await realSyncBackend.audit();
    const startedPids = stopped.filter((row) => row.event === 'started' && Number.isInteger(row.pid));
    for (const row of startedPids) {
      try { process.kill(row.pid!, 0); throw new Error('本轮自有CLI进程仍存活。'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const after = await realSyncBackend.audit();
    expect(after.filter((row) => row.event === 'started' && Number.isInteger(row.pid))).toHaveLength(startedPids.length);
    expect(after.filter((row: CliAudit & { code?: string }) => row.event === 'scope_rejected'
      && !(row.kind === 'sessions' && row.code === 'acceptance_session_listing_blocked'))).toEqual([]);
    await writeFile(test.info().outputPath('real-sync-normal-quit-results.json'), JSON.stringify({
      packaged: true, uniqueConfirmedContact: true, ...snapshot,
      atLeastTwoActualTailAcceptances: true, globalStreamActiveBeforeQuit: true,
      normalQuitExitZero: true, authenticatedStopped: true, backendGone: true, ownedCliGone: true,
      cliStartsAtStop: startedPids.length, cliStartsFiveSecondsAfterStop: startedPids.length,
      externalForegroundCertified: false, newIncomingMessageCertified: false,
      twoContactContinuityCertified: false, sessionListingCertified: false, ocrRun: false, modelCalls: 0,
    }), { mode: 0o600 });
  });
