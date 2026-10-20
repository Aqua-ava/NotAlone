import { confirmHelperContact } from './foreground-confirmation-actions';
import { expect, type ElectronApplication } from '@playwright/test';
import { readContactHttp, test } from './contact-fixture';
import { writeFile } from 'node:fs/promises';
import { startContactConfirmationWitness, witnessFailureCode, WitnessSetupFailure } from './contact-confirmation-witness';

test('真实目录只显示当前用户的联系人及消息摘要', async ({ runningApp: { app }, contactBackend }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByRole('status').filter({ hasText: '已连接' })).toBeVisible({ timeout: 15_000 });
  expect(await readContactHttp(contactBackend)).toEqual({ contacts: [
    { contact_id: contactBackend.data.contact_ids[0], display_name: '合成联系人甲', data_status: { message_count: 2, source_count: 1 } },
    { contact_id: contactBackend.data.contact_ids[1], display_name: '合成联系人乙', data_status: { message_count: 1, source_count: 1 } },
  ] });
  const contacts = manager.getByRole('region', { name: '联系人目录' });
  await expect(contacts.getByText('合成联系人甲', { exact: true })).toBeVisible();
  await expect(contacts.getByText('合成联系人乙', { exact: true })).toBeVisible();
  await expect(contacts.getByText('另一用户的联系人', { exact: true })).toHaveCount(0);
  await expect(contacts.getByText('2 条消息', { exact: true })).toBeVisible();
  await expect(contacts.getByText('1 条消息', { exact: true })).toBeVisible();
  await expect(manager.getByText('本次联系人：未确认', { exact: true })).toBeVisible();
});

test('两个窗口共享本次联系人，隐藏恢复保留草稿，A→B→A 不恢复旧文本', async ({ runningApp: { app }, contactBackend }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await expect(manager.getByRole('button', { name: '选择合成联系人甲', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗' }).click();
  const helper = await opened;
  await installContactFocusDiagnostic(app,
    await (await app.browserWindow(manager)).evaluate((window) => window.id),
    await (await app.browserWindow(helper)).evaluate((window) => window.id));
  let diagnosticPhase = 'windows-created';
  const focusCheckpoints: Array<Record<string, unknown>> = [];
  const recordFocus = async (phase: string) => {
    diagnosticPhase = phase;
    const windows = await readDiagnostic(() => app.evaluate((_electron, phase) => {
      const diagnostic = (globalThis as ContactFocusDiagnosticGlobal).contactFocusDiagnostic;
      return diagnostic?.record('checkpoint', phase) ?? null;
    }, phase));
    const foreground = await readDiagnostic(() => helper.evaluate(async () => {
      const state = await window.notalone.foreground.getState();
      return { phase: state.phase, reason: state.reason, suspendedByHelperFocus: state.suspendedByHelperFocus,
        revision: state.revision, foregroundRevision: state.foregroundRevision };
    }));
    focusCheckpoints.push({ phase, observedAt: Date.now(), windows, foreground });
    if (focusCheckpoints.length > 64) focusCheckpoints.shift();
  };
  let witness: Awaited<ReturnType<typeof startContactConfirmationWitness>> | undefined;
  let originalFailed = false;
  let failedAtPhase: string | null = null;
  let selectionHistoryInstalled = false;
  let selectionCompleted = false;
  const selectionState = () => helper.evaluate(async (contactIds) => {
    const contacts = await window.notalone.contacts.getState();
    const foreground = await window.notalone.foreground.getState();
    return { selectedFixtureIndex: contactIds.indexOf(contacts.selectedContactId ?? ''),
      scopeRevision: contacts.scopeRevision, directoryPhase: contacts.directoryPhase,
      foregroundRevision: foreground.foregroundRevision, stateRevision: foreground.revision,
      phase: foreground.phase, confirmation: foreground.confirmation,
      suspendedByHelperFocus: foreground.suspendedByHelperFocus };
  }, contactBackend.data.contact_ids);
  try {
    await recordFocus('windows-created');
    await expect(helper.getByRole('combobox', { name: '本次联系人' })).toHaveValue(contactBackend.data.contact_ids[0]);
    await expect(helper.getByText('本次联系人：合成联系人甲', { exact: true })).toBeVisible();
    // 提前订阅有限状态，关键切换间隙不追加RPC；收到的版本不冒充实际提交版本。
    await helper.evaluate((contactIds) => {
      const history: Array<Record<string, unknown>> = [];
      const record = (value: Record<string, unknown>) => {
        history.push({ at: performance.now(), ...value });
        if (history.length > 24) history.shift();
      };
      let deliveredForegroundRevision: number | null = null;
      const stopForeground = window.notalone.foreground.onStateChanged((state) => {
        deliveredForegroundRevision = state.foregroundRevision;
        record({ kind: 'foreground', revision: state.revision, foregroundRevision: state.foregroundRevision,
          phase: state.phase, confirmation: state.confirmation, suspendedByHelperFocus: state.suspendedByHelperFocus });
      });
      const stopContacts = window.notalone.contacts.onStateChanged((state) => {
        if ('kind' in state) return;
        record({ kind: 'contacts', revision: state.revision, scopeRevision: state.scopeRevision,
          selectedFixtureIndex: contactIds.indexOf(state.selectedContactId ?? ''), directoryPhase: state.directoryPhase });
      });
      const changed = (event: Event) => {
        const target = event.target;
        if (target instanceof HTMLSelectElement && target.getAttribute('aria-label') === '本次联系人') {
          record({ kind: 'picker-change', selectedFixtureIndex: contactIds.indexOf(target.value), deliveredForegroundRevision });
        }
      };
      document.addEventListener('change', changed, true);
      (window as Window & { selectionDiagnostic?: () => Array<Record<string, unknown>> }).selectionDiagnostic = () => {
        stopForeground(); stopContacts(); document.removeEventListener('change', changed, true);
        return history;
      };
    }, contactBackend.data.contact_ids);
    selectionHistoryInstalled = true;
    if (process.env.NOTALONE_TEST_CONTACT_CONFIRMATION_WITNESS === '1') {
      try { witness = await startContactConfirmationWitness(app, manager, contactBackend.data.contact_ids); }
      catch (error) {
        const code = witnessFailureCode(error);
        const report = error instanceof WitnessSetupFailure ? error.witnessReport : null;
        await writeFile(test.info().outputPath('confirmation-witness.json'), JSON.stringify({ valid: false, stage: 'setup', code, report }), { mode: 0o600 });
        throw new Error('本轮联系人确认诊断的前置核验未通过。');
      }
    }
    const draft = helper.getByRole('textbox', { name: '草稿' });
    const helperFocusPause = helper.getByRole('region', { name: '前台会话定位', exact: true })
      .getByText('小窗在前台，暂停新的前台定位；已确认范围的后台同步独立运行。', { exact: true });
    await expect(draft).toBeEnabled();
    await draft.fill('只给甲的本次草稿。');
    await recordFocus('before-helper-hide');
    await helper.getByRole('button', { name: '隐藏输入小窗' }).click();
    await expect.poll(() => app.browserWindow(helper).then((window) => window.evaluate((window) => window.isVisible()))).toBe(false);
    await recordFocus('helper-hidden');
    await recordFocus('before-helper-restore-click');
    await manager.getByRole('button', { name: '打开输入小窗' }).click();
    await recordFocus('after-helper-restore-click');
    await expect(draft).toBeVisible();
    await expect(draft).toHaveValue('只给甲的本次草稿。');
    await recordFocus('before-helper-focus-pause-assertion');
    await expect(helperFocusPause).toBeVisible();
    await recordFocus('helper-focus-pause-visible');
    await (await app.browserWindow(manager)).evaluate((window) => window.close());
    await helper.getByRole('button', { name: '打开管理后台' }).click();
    await expect(manager.getByRole('button', { name: '选择合成联系人甲', exact: true })).toHaveAttribute('aria-pressed', 'true');
    diagnosticPhase = 'before-contact-selection';
    await expect(helperFocusPause).toHaveCount(0);
    await helper.getByRole('combobox', { name: '本次联系人' }).selectOption(contactBackend.data.contact_ids[1]);
    await expect(manager.getByText('本次联系人：合成联系人乙', { exact: true })).toBeVisible();
    selectionCompleted = true;
    await expect(draft).toHaveValue('');
    await draft.fill('只给乙的本次草稿。');
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await expect(helper.getByRole('combobox', { name: '本次联系人' })).toHaveValue(contactBackend.data.contact_ids[0]);
    await expect(draft).toHaveValue('');
    await draft.fill('甲的新草稿，继续本次编辑。');
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await manager.getByRole('button', { name: '刷新联系人' }).click();
    await expect(manager.getByText('正在读取联系人目录…', { exact: true })).toHaveCount(0);
    await expect(draft).toHaveValue('甲的新草稿，继续本次编辑。');
    await confirmHelperContact(helper, contactBackend.data.contact_ids[0]);
    await expect(helper.getByRole('button', { name: '生成候选' })).toBeEnabled();
    await expect(helper.getByRole('button', { name: '复制', exact: true })).toBeDisabled();
    await helper.screenshot({ path: test.info().outputPath('contact-helper.png') });
    await manager.screenshot({ path: test.info().outputPath('contact-manager.png') });
    diagnosticPhase = 'original-actions-completed';
  } catch (error) {
    originalFailed = true;
    failedAtPhase = diagnosticPhase;
    await recordFocus(`failed-at-${diagnosticPhase}`);
    throw error;
  }
  finally {
    await recordFocus(originalFailed ? 'exit-after-failure' : 'exit-after-success');
    const eventHistory = await readDiagnostic(() => app.evaluate(() => {
      const owner = globalThis as ContactFocusDiagnosticGlobal;
      const result = owner.contactFocusDiagnostic?.stop() ?? null;
      delete owner.contactFocusDiagnostic;
      return result;
    }));
    let diagnosticSaved = true;
    try {
      await writeFile(test.info().outputPath('contact-focus-observations.json'), JSON.stringify({
        version: 1, originalFailed, failedAtPhase, historyLimit: 64, eventHistory, checkpoints: focusCheckpoints,
        osForegroundIdentityCertified: false,
      }), { mode: 0o600 });
    } catch { diagnosticSaved = false; }
    const history = await readDiagnostic(() => helper.evaluate(() =>
      (window as Window & { selectionDiagnostic?: () => Array<Record<string, unknown>> }).selectionDiagnostic?.() ?? []));
    const exitState = await readDiagnostic(selectionState);
    const confirmationRejectedPresent = await readDiagnostic(async () =>
      await helper.getByText('联系人确认已失效，请重新选择本次联系人。', { exact: true }).count() > 0);
    try {
      await writeFile(test.info().outputPath('selection-observations.json'), JSON.stringify({
        observedAtPhase: diagnosticPhase, originalFailed, failedAtPhase,
        selectionHistoryInstalled, selectionCompleted, history, exitState,
        confirmationRejectedPresent, submittedReactRevisionCertified: false,
      }), { mode: 0o600 });
    } catch { diagnosticSaved = false; }
    if (witness) {
      const report = await witness.stop();
      try {
        await writeFile(test.info().outputPath('confirmation-witness.json'), JSON.stringify({ ...report, stage: 'finished', originalFailed }), { mode: 0o600 });
      } catch { if (!originalFailed) throw new Error('本轮联系人确认诊断收据未保存。'); }
      if (!originalFailed) expect(report.valid).toBe(true);
    }
    if (!originalFailed && !diagnosticSaved) throw new Error('本轮窗口或联系人状态诊断收据未保存。');
  }
});

interface ContactFocusDiagnostic {
  record(kind: string, phase?: string, window?: 'manager' | 'helper'): Record<string, unknown>;
  stop(): { records: Array<Record<string, unknown>>; droppedRecords: number };
}
type ContactFocusDiagnosticGlobal = typeof globalThis & { contactFocusDiagnostic?: ContactFocusDiagnostic };

async function readDiagnostic<T>(read: () => Promise<T>) {
  try { return { status: 'read' as const, value: await read() }; }
  catch { return { status: 'unavailable' as const }; }
}

async function installContactFocusDiagnostic(app: ElectronApplication, managerId: number, helperId: number) {
  // 只订阅既有事件并读取两窗口状态；不改变焦点、显隐或前台定位门。
  await app.evaluate(({ app, BrowserWindow }, ids) => {
    const owned = [
      { role: 'manager' as const, window: BrowserWindow.fromId(ids.managerId) },
      { role: 'helper' as const, window: BrowserWindow.fromId(ids.helperId) },
    ];
    if (owned.some(({ window }) => !window)) throw new Error('窗口诊断所需的两个窗口不存在。');
    const records: Array<Record<string, unknown>> = [];
    const unsubscribe: Array<() => void> = [];
    let phase = 'windows-created';
    let droppedRecords = 0;
    const record: ContactFocusDiagnostic['record'] = (kind, nextPhase, eventWindow) => {
      if (nextPhase) phase = nextPhase;
      const entry = { at: Date.now(), phase, kind, eventWindow: eventWindow ?? null, appIsHidden: app.isHidden(),
        windows: owned.map(({ role, window }) => ({ role, destroyed: window!.isDestroyed(),
          isVisible: window!.isDestroyed() ? null : window!.isVisible(),
          isFocused: window!.isDestroyed() ? null : window!.isFocused(),
          isMinimized: window!.isDestroyed() ? null : window!.isMinimized() })) };
      records.push(entry);
      if (records.length > 64) { records.shift(); droppedRecords += 1; }
      return entry;
    };
    const activated = () => { record('app.activate'); };
    app.on('activate', activated);
    unsubscribe.push(() => app.off('activate', activated));
    const windowEvent = (kind: string, window: Electron.BrowserWindow) => {
      const matched = owned.find((item) => item.window === window);
      if (matched) record(kind, undefined, matched.role);
    };
    const focused = (_event: Electron.Event, window: Electron.BrowserWindow) => { windowEvent('app.browser-window-focus', window); };
    const blurred = (_event: Electron.Event, window: Electron.BrowserWindow) => { windowEvent('app.browser-window-blur', window); };
    app.on('browser-window-focus', focused);
    app.on('browser-window-blur', blurred);
    unsubscribe.push(() => app.off('browser-window-focus', focused), () => app.off('browser-window-blur', blurred));
    for (const { role, window } of owned) {
      const emitter: NodeJS.EventEmitter = window!;
      for (const event of ['show', 'hide', 'focus', 'blur', 'closed'] as const) {
        const listener = () => { record(`window.${event}`, undefined, role); };
        emitter.on(event, listener);
        unsubscribe.push(() => emitter.off(event, listener));
      }
    }
    (globalThis as ContactFocusDiagnosticGlobal).contactFocusDiagnostic = {
      record,
      stop: () => { for (const stop of unsubscribe) stop(); return { records, droppedRecords }; },
    };
    record('installed');
  }, { managerId, helperId });
}
