import { expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { selectMenu } from './app-fixture';
import { confirmShortcutFeedback } from './native-shortcut-coordination';
import { test } from './real-sync-quit-fixture';
import { foregroundMetadataCounts, foregroundQuitPids, verifyForegroundAuditAppend,
  type ForegroundAuditSnapshot } from './real-foreground-credential';

test.skip(process.env.NOTALONE_REAL_FOREGROUND_LOCATOR_ACCEPTANCE !== '1', '主 Agent 须提供真实 G 成功凭据与唯一认可联系人范围');
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('同E真实探针单联系人定位，撤销保护与焦点独立停读，正常退出', async ({ runningApp: { app, appProcess, userData }, realSyncBackend, realSyncProxy }) => {
  test.setTimeout(420_000);
  if (!realSyncBackend.foreground) throw new Error('真实校准凭据尚未核验。');
  const backendPid = realSyncBackend.cleanupOwnership().childPid!;
  const contactId = realSyncBackend.data.contact_ids[0];
  await writeFile(test.info().outputPath('owned-runtime.json'), JSON.stringify({ appPid: appProcess.pid, backendPid,
    userData, fixtureDirectory: realSyncBackend.directory, databaseName: realSyncBackend.data.database_name }), { mode: 0o600 });
  const profilePath = path.join(userData, 'foreground-layout-profile.json');
  await writeFile(profilePath, realSyncBackend.foreground.profileBytes, { mode: 0o600, flag: 'wx' });
  expect(createHash('sha256').update(await readFile(profilePath)).digest('hex') === realSyncBackend.foreground.profileSha256).toBe(true);
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  realSyncProxy.observeForeground(contactId);
  const report = { calibrationEvidenceValidatedBeforeLaunch: true, originalProfileCopiedUnchanged: true,
    sameENativeBytesConfigured: true, verifiedContactLocated: false, helperFocusFreshSuppressed: false,
    actualHelperFrontPaused: false, cliReadAfterHelperFocus: false, existingDraftPreserved: false,
    bindingRevocationRejectedOldConfirmation: false, revokedBindingNotAutoLocated: false,
    normalQuit: false, authenticatedStopped: false, recordedBackendGone: false, recordedCliGone: false,
    recordedCliGroupsGone: false,
    postQuitNoNewStarts: false, realIncomingArrivalCertified: false, twoContactsCertified: false,
    realLowConfidenceOrDuplicateCertified: false, TCCResponsibleChainCertified: false,
    rawFrameCounterCertified: false, nativeHelperFrontPreCaptureRejectionSourceInferred: false, modelCalls: 0, sentMessages: 0 };
  const manager = await app.firstWindow();
  let channelCounts: { messageCount: number; observationReferenceCount: number; duplicateIdentities: number } | null = null;
  const accepted = async () => (await realSyncBackend.audit()).filter(row => row.event === 'accepted' && row.kind === 'tail').length;
  const checkAudit = async () => {
    const audit = await realSyncBackend.audit();
    expect(audit.some((row: { event: string; kind: string; code?: string }) => row.event === 'scope_rejected'
      && !(row.kind === 'sessions' && row.code === 'acceptance_session_listing_blocked'))).toBe(false);
  };
  const helperState = async (helper: Page) => helper.evaluate(async (expected) => {
    const contact = await window.notalone.contacts.getState();
    const foreground = await window.notalone.foreground.getState();
    return { sameContact: contact.selectedContactId === expected, phase: foreground.phase, reason: foreground.reason,
      confirmation: foreground.confirmation, confirmedExpected: foreground.confirmedContactId === expected,
      suggestedExpected: foreground.suggestedContactId === expected, blocked: foreground.generationBlock !== null,
      helperFocusedPause: foreground.suspendedByHelperFocus };
  }, contactId);
  const manuallyShowFromWechat = async () => {
    // 只等主 Agent 本次实际切换及独立收据；真正 OS 微信前台仍须后续原生 observe 证明。
    await confirmShortcutFeedback('external-focus', 'agent', async timeout => {
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isFocused())), { timeout }).toBe(true);
    }, Math.min(Date.now() + 90_000, realSyncBackend.scope.until * 1000));
    await selectMenu(app, '窗口', '输入小窗');
    await expect.poll(() => app.windows().filter(page => page.url().endsWith('#helper')).length).toBe(1);
    const helper = app.windows().find(page => page.url().endsWith('#helper'));
    if (!helper) throw new Error('公开输入小窗尚未出现。');
    return helper;
  };
  const gone = (pid: number, group = false) => {
    try { process.kill(group ? -pid : pid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
  };
  let originalFailed = false;
  let stoppedAudit: ForegroundAuditSnapshot | undefined;
  try {
    await expect(manager.getByRole('status').filter({ hasText: '已连接' })).toBeVisible({ timeout: 15_000 });
    await manager.getByRole('button', { name: '同步设置', exact: true }).click();
    await manager.getByRole('button', { name: '开启后台同步', exact: true }).click();
    await expect.poll(accepted, { timeout: 70_000 }).toBeGreaterThan(0);
    await checkAudit();
    const helper = await manuallyShowFromWechat();
    await expect.poll(() => helperState(helper)).toMatchObject({ sameContact: true, confirmation: 'verified-binding',
      confirmedExpected: true, phase: 'confirmed', reason: 'confirmed_active_binding', blocked: false, helperFocusedPause: true });
    expect(realSyncProxy.foregroundReport()?.received).toBe(1);
    expect(realSyncProxy.foregroundReport()?.requests).toBe(1);
    expect(realSyncProxy.foregroundReport()?.invalid).toBe(false);
    report.verifiedContactLocated = true;
    await checkAudit();
    const startsBeforeFocus = await accepted();
    await selectMenu(app, '窗口', '输入小窗');
    expect(realSyncProxy.foregroundReport()?.received).toBe(1);
    expect(realSyncProxy.foregroundReport()?.requests).toBe(1);
    report.helperFocusFreshSuppressed = true;
    const paused = await realSyncBackend.request('/api/sync/foreground/observe', {});
    expect(paused.status).toBe(200);
    expect(paused.data.phase === 'paused' && paused.data.reason === 'wechat_not_in_front'
      && paused.data.wechat_in_front === false && paused.data.contact_id === null && paused.data.binding_id === null).toBe(true);
    report.actualHelperFrontPaused = true;
    report.nativeHelperFrontPreCaptureRejectionSourceInferred = true;
    await expect.poll(async () => {
      expect((await helperState(helper)).helperFocusedPause).toBe(true);
      return accepted();
    }, { timeout: 70_000 }).toBeGreaterThan(startsBeforeFocus);
    report.cliReadAfterHelperFocus = true;
    await checkAudit();
    const channel = await realSyncBackend.request('/api/sync/follow-smoke/status');
    expect(channel.status).toBe(200);
    const contacts = channel.data.contacts;
    if (!Array.isArray(contacts) || contacts.length !== 1) throw new Error('本轮真实同步计数目录不符。');
    const observed = contacts[0];
    expect(observed.contact_id === contactId && observed.bound === true && channel.data.follow_stream_active === true).toBe(true);
    for (const key of ['message_count', 'observation_ref_count', 'duplicate_identities']) {
      expect(Number.isSafeInteger(observed[key]) && observed[key] >= 0).toBe(true);
    }
    expect(observed.duplicate_identities).toBe(0);
    channelCounts = { messageCount: observed.message_count, observationReferenceCount: observed.observation_ref_count,
      duplicateIdentities: observed.duplicate_identities };
    const draft = helper.getByRole('textbox', { name: '草稿', exact: true });
    await draft.fill('定位验收合成草稿（不发送）');
    await helper.getByRole('button', { name: '隐藏输入小窗', exact: true }).click();
    await manuallyShowFromWechat();
    await expect.poll(() => helperState(helper)).toMatchObject({ sameContact: true, phase: 'manual-required',
      reason: 'existing_edits_require_confirmation', suggestedExpected: true, blocked: true, confirmation: 'required' });
    await expect(draft).toHaveValue('定位验收合成草稿（不发送）');
    await helper.getByRole('button', { name: '确认微信会话对应联系人', exact: true }).click();
    await expect.poll(() => helperState(helper)).toMatchObject({ sameContact: true, confirmation: 'manual-confirmed', blocked: false });
    const oldConfirmation = await helper.evaluate(async () => {
      const contact = await window.notalone.contacts.getState(); const foreground = await window.notalone.foreground.getState();
      return { contactId: contact.selectedContactId!, contactScopeRevision: contact.scopeRevision, foregroundRevision: foreground.foregroundRevision };
    });
    report.existingDraftPreserved = true;
    await helper.getByRole('button', { name: '打开管理后台', exact: true }).click();
    await manager.getByRole('button', { name: '联系人', exact: true }).click();
    await manager.getByRole('button', { name: '刷新联系人', exact: true }).click();
    await expect.poll(() => manager.evaluate(async () => (await window.notalone.bindings.getState()).phase)).toBe('ready');
    await manager.evaluate(async expected => {
      const state = await window.notalone.bindings.getState();
      if (state.bindings.length !== 1 || state.bindings[0].contactId !== expected) throw new Error('本轮唯一授权目录不符。');
      await window.notalone.bindings.revokeBinding({ scopeRevision: state.scopeRevision,
        contactId: expected, bindingId: state.bindings[0].bindingId });
    }, contactId);
    await expect.poll(() => manager.evaluate(async () => (await window.notalone.bindings.getState()).bindings.length)).toBe(0);
    expect(await helper.evaluate(async selection => {
      try { await window.notalone.foreground.confirm(selection); return false; }
      catch (error) { return error instanceof Error && error.message.includes('联系人确认已失效'); }
    }, oldConfirmation)).toBe(true);
    await expect(draft).toHaveValue('定位验收合成草稿（不发送）');
    expect((await helperState(helper)).blocked).toBe(true);
    report.bindingRevocationRejectedOldConfirmation = true;
    await helper.getByRole('button', { name: '隐藏输入小窗', exact: true }).click();
    await manuallyShowFromWechat();
    await expect.poll(() => helperState(helper)).toMatchObject({ sameContact: true, phase: 'manual-required',
      reason: 'unmatched_requires_selection', confirmation: 'required', blocked: true, confirmedExpected: false });
    await expect(draft).toHaveValue('定位验收合成草稿（不发送）');
    expect(realSyncProxy.foregroundReport()?.received).toBe(4);
    expect(realSyncProxy.foregroundReport()?.requests).toBe(4);
    expect(realSyncProxy.foregroundReport()?.invalid).toBe(false);
    report.revokedBindingNotAutoLocated = true;
    await checkAudit();
    const beforeQuit = await realSyncBackend.foregroundAudit();
    const beforeQuitPids = foregroundQuitPids(beforeQuit);
    await writeFile(test.info().outputPath('pre-quit-cli-audit.json'), JSON.stringify({
      startedPids: beforeQuitPids, rowCount: beforeQuit.rows.length, lineDigests: beforeQuit.lineDigests,
    }), { mode: 0o600, flag: 'wx' });
    await selectMenu(app, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => appProcess.exitCode, { timeout: 15_000 }).toBe(0); report.normalQuit = true;
    expect(realSyncProxy.authenticatedRuntimeStopped).toBe(true); report.authenticatedStopped = true;
    await expect.poll(() => gone(backendPid), { timeout: 15_000 }).toBe(true); report.recordedBackendGone = true;
    stoppedAudit = await realSyncBackend.foregroundAudit();
    verifyForegroundAuditAppend(beforeQuit, stoppedAudit);
    const startedPids = foregroundQuitPids(stoppedAudit);
    expect(startedPids.every(pid => gone(pid))).toBe(true); report.recordedCliGone = true;
    expect(startedPids.every(pid => gone(pid, true))).toBe(true); report.recordedCliGroupsGone = true;
    await new Promise(resolve => setTimeout(resolve, 5000));
    verifyForegroundAuditAppend(stoppedAudit, await realSyncBackend.foregroundAudit(), false);
    report.postQuitNoNewStarts = true;
    await checkAudit();
  } catch (error) { originalFailed = true; throw error; }
  finally {
    let metadataCounts: Array<Record<string, unknown>> | null = null;
    let metadataError: string | null = null;
    try {
      const finalAudit = await realSyncBackend.foregroundAudit();
      if (stoppedAudit) verifyForegroundAuditAppend(stoppedAudit, finalAudit, false);
      metadataCounts = foregroundMetadataCounts(finalAudit);
    } catch { metadataError = 'metadata_count_unverified'; }
    try {
      await writeFile(test.info().outputPath('real-foreground-locator-results.json'), JSON.stringify({ ...report,
        channelCounts, metadataCounts, metadataError, freshObservations: realSyncProxy.foregroundReport(),
        partialOrFailed: !report.postQuitNoNewStarts || metadataError !== null }), { mode: 0o600, flag: 'wx' });
    } catch { if (!originalFailed) throw new Error('真实定位验收收据未保存。'); }
    if (!originalFailed) {
      expect(metadataError).toBeNull();
      expect(realSyncProxy.foregroundReport()?.invalid).toBe(false);
      expect(realSyncProxy.foregroundReport()?.received).toBe(4);
      expect(realSyncProxy.foregroundReport()?.requests).toBe(4);
    }
  }
});
