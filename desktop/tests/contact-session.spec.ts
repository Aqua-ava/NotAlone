import { confirmHelperContact } from './foreground-confirmation-actions';
import { expect } from '@playwright/test';
import { readContactHttp, test } from './contact-fixture';
import { writeFile } from 'node:fs/promises';

test('真实目录只显示当前用户的联系人及消息与来源摘要', async ({ runningApp: { app }, contactBackend }) => {
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
  await expect(contacts.getByText('2 条消息 · 1 份来源', { exact: true })).toBeVisible();
  await expect(contacts.getByText('1 条消息 · 1 份来源', { exact: true })).toBeVisible();
  await expect(manager.getByText('本次联系人：未确认', { exact: true })).toBeVisible();
});

test('两个窗口共享本次联系人，隐藏恢复保留草稿，A→B→A 不恢复旧文本', async ({ runningApp: { app }, contactBackend }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await expect(manager.getByRole('button', { name: '选择合成联系人甲', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗' }).click();
  const helper = await opened;
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
  const draft = helper.getByRole('textbox', { name: '草稿' });
  await expect(draft).toBeEnabled();
  await draft.fill('只给甲的本次草稿。');
  await helper.getByRole('button', { name: '隐藏输入小窗' }).click();
  await expect.poll(() => app.browserWindow(helper).then((window) => window.evaluate((window) => window.isVisible()))).toBe(false);
  await manager.getByRole('button', { name: '打开输入小窗' }).click();
  await expect(draft).toBeVisible();
  await expect(draft).toHaveValue('只给甲的本次草稿。');
  await (await app.browserWindow(manager)).evaluate((window) => window.close());
  await helper.getByRole('button', { name: '打开管理后台' }).click();
  await expect(manager.getByRole('button', { name: '选择合成联系人甲', exact: true })).toHaveAttribute('aria-pressed', 'true');
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
    await helper.getByRole('combobox', { name: '本次联系人' }).selectOption(contactBackend.data.contact_ids[1]);
    await expect(manager.getByText('本次联系人：合成联系人乙', { exact: true })).toBeVisible();
  } finally {
    await writeFile(test.info().outputPath('selection-observations.json'), JSON.stringify({
      history: await helper.evaluate(() => (window as Window & { selectionDiagnostic?: () => Array<Record<string, unknown>> }).selectionDiagnostic?.() ?? []),
      afterSelection: await selectionState(),
      confirmationRejectedPresent: await helper.getByText('联系人确认已失效，请重新选择本次联系人。', { exact: true }).count() > 0,
      submittedReactRevisionCertified: false,
    }), { mode: 0o600 });
  }
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
});
