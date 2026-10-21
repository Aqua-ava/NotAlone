import { setWorkspaceContext, setWorkspaceTone, fillWorkspaceInstruction, openWorkspaceSettings } from './workspace-actions';
import { expect, type Page } from '@playwright/test';
import type { BindingFixture } from './binding-backend-fixture';
import type { PageTransportControl } from './headless/renderer';

// 首条后端red准备：真实认证HTTP与合成外部probe，未运行。
export async function foregroundObservationPaused(backend: BindingFixture): Promise<void> {
  const contactId = backend.data.contact_ids[0];
  const confirmation = await backend.request('/api/sync/cli-bindings/confirm', { selections: [
    { locator: 'wxid_synthetic_a', contact_id: contactId },
  ] });
  expect(confirmation.status).toBe(200);
  expect((await backend.request('/api/sync/enable', {})).status).toBe(200);
  const tails = await backend.tails();
  const response = await backend.request('/api/sync/foreground/observe', {});
  expect(response.status).toBe(200);
  expect(response.data.phase).toBe('paused');
  expect(response.data.probe_available).toBe(true);
  expect(response.data.wechat_in_front).toBe(false);
  expect(response.data.binding_id).toBeNull();
  expect(response.data.contact_id).toBeNull();
  expect(response.data.observation_id).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  expect(Number.isFinite(Date.parse(String(response.data.observed_at)))).toBe(true);
  expect(typeof response.data.reason).toBe('string');
  expect(response.data.reason).not.toBe('');
  expect(Object.keys(response.data).sort()).toEqual(['binding_id', 'contact_id', 'observation_id', 'observed_at',
    'phase', 'probe_available', 'reason', 'wechat_in_front']);
  expect(await backend.tails()).toEqual(tails);
  expect((await backend.request('/api/sync/foreground/observe', { contact_id: contactId })).status).toBe(400);
}

// 不把合成probe当原生焦点证明；暂停仍允许手选并保留草稿。
export async function foregroundPausedWithManualDraft(manager: Page, helper: Page, backend: BindingFixture): Promise<void> {
  const contactId = backend.data.contact_ids[0];
  await expect(helper.getByRole('combobox', { name: '本次联系人', exact: true })).toBeEnabled();
  type DiagnosticWindow = Window & { pageTransportControl?: PageTransportControl;
    foregroundChoiceCommands?: Array<{ channel: string; outcome: string; reason?: string }>;
    stopForegroundChoiceObservation?: () => void };
  await manager.evaluate(() => {
    const surface = window as DiagnosticWindow, previous = surface.pageTransportControl;
    const commands: NonNullable<DiagnosticWindow['foregroundChoiceCommands']> = [];
    surface.foregroundChoiceCommands = commands;
    surface.pageTransportControl = {
      receiveEvent: (channel, state) => previous?.receiveEvent(channel, state) ?? false,
      observeInvoke(channel, args, pending) {
        previous?.observeInvoke(channel, args, pending);
        if (!['foreground:confirm', 'contacts:confirm-manual', 'contacts:select'].includes(channel)) return;
        const command: typeof commands[number] = { channel, outcome: 'pending' }; commands.push(command);
        void pending.then(() => { command.outcome = 'fulfilled'; }, error => {
          command.outcome = 'rejected';
          command.reason = ['foreground_binding_required', '联系人确认已失效', '微信绑定暂时无法核验', '联系人选择已失效']
            .find(reason => String(error).includes(reason)) ?? 'other';
        });
      },
    };
    surface.stopForegroundChoiceObservation = () => { surface.pageTransportControl = previous; delete surface.stopForegroundChoiceObservation; };
  });
  try {
    // 跨账号夹具不满足前台唯一绑定；管理页选择只确定本地草稿归属，不授予生成资格。
    const selected = await manager.evaluate(async contactId => {
      const state = await window.notalone.contacts.getState();
      const selected = await window.notalone.contacts.selectContact({ contactId, scopeRevision: state.scopeRevision });
      return { contactId: selected.selectedContactId, scopeRevision: selected.scopeRevision };
    }, contactId);
    expect(selected.contactId).toBe(contactId);
    await expect.poll(() => helper.evaluate(async () => {
      const [contact, reply] = await Promise.all([window.notalone.contacts.getState(), window.notalone.replies.getState()]);
      return { contactId: contact.selectedContactId, scopeRevision: contact.scopeRevision,
        replyContactId: reply.contactId, replyScopeRevision: reply.scopeRevision };
    })).toEqual({ ...selected, replyContactId: contactId, replyScopeRevision: selected.scopeRevision });
    await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('本轮手选联系人的合成草稿');
  } catch (error) {
    const diagnostic = await helper.evaluate(async expected => {
      const [contacts, foreground, replies] = await Promise.all([window.notalone.contacts.getState(),
        window.notalone.foreground.getState(), window.notalone.replies.getState()]);
      return { contactSelected: contacts.selectedContactId !== null, contactMatches: contacts.selectedContactId === expected,
        directoryPhase: contacts.directoryPhase, contactScope: contacts.scopeRevision,
        replyContactMatches: replies.contactId === expected, replyScope: replies.scopeRevision,
        foregroundPhase: foreground.phase, foregroundReason: foreground.reason, foregroundRevision: foreground.foregroundRevision,
        foregroundConfirmation: foreground.confirmation, foregroundBlock: foreground.generationBlock,
        manualInput: foreground.manualInput, confirmedMatches: foreground.confirmedContactId === expected,
        replyPhase: replies.phase, replyMode: replies.mode, replyBlock: replies.generationBlock, inputKind: replies.options.inputKind,
        savedPhase: replies.savedSession?.phase, hasSavedSession: Boolean(replies.savedSession?.sessionId),
        catalogPhase: replies.sessionCatalog?.phase, selectionPending: replies.sessionCatalog?.selectionPending,
        sourceAvailability: replies.sourceAvailability, sessionDeletion: replies.sessionDeletion };
    }, contactId);
    const commands = await manager.evaluate(() => (window as DiagnosticWindow).foregroundChoiceCommands);
    // 只记录阶段、范围序号和身份相等性，不输出草稿、联系人或绑定正文。
    process.stderr.write(`page_test_foreground_draft: ${JSON.stringify({ ...diagnostic, commands })}\n`);
    throw error;
  } finally { await manager.evaluate(() => (window as DiagnosticWindow).stopForegroundChoiceObservation?.()); }
  const locator = helper.getByRole('region', { name: '前台会话定位', exact: true });
  await expect(locator.getByText('前台定位已暂停', { exact: true })).toBeVisible();
  await expect(helper.getByRole('combobox', { name: '本次联系人', exact: true })).toHaveAttribute('data-contact-id', contactId);
  await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('本轮手选联系人的合成草稿');
  expect(await helper.evaluate(async () => {
    const [foreground, reply] = await Promise.all([window.notalone.foreground.getState(), window.notalone.replies.getState()]);
    return { confirmation: foreground.confirmation, confirmedContactId: foreground.confirmedContactId,
      foregroundBlock: foreground.generationBlock, replyBlock: reply.generationBlock };
  })).toEqual({ confirmation: 'required', confirmedContactId: null,
    foregroundBlock: 'foreground-confirmation-required', replyBlock: 'foreground-confirmation-required' });
  await expect(helper.getByRole('button', { name: '帮我表达', exact: true })).toBeDisabled();
  await expect(helper.getByRole('button', { name: '帮我想想', exact: true })).toBeDisabled();
  expect(await helper.evaluate(async () => {
    const contact = await window.notalone.contacts.getState();
    try { await window.notalone.replies.generate({ contactId: contact.selectedContactId!, scopeRevision: contact.scopeRevision, newRequest: false }); return null; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })).toContain('请先确认本次联系人');
  const report = await backend.request('/api/sync/status');
  expect(report.status).toBe(200);
  expect(report.data.sync_enabled).toBe(true);
}

// 下一单条red准备：当前helper确认与生成门禁尚未实现，本场尚未运行。
export async function foregroundManualConfirmation(manager: Page, openHelper: () => Promise<Page>,
  backend: BindingFixture, setVisible: (visible: boolean) => Promise<void>): Promise<void> {
  const choice = manager.getByRole('region', { name: '联系人目录', exact: true }).getByRole('button', { name: /^选择/ }).first();
  await choice.click();
  const selected = await manager.evaluate(async () => (await window.notalone.contacts.getState()).selectedContactId);
  expect(selected).not.toBeNull();
  expect(backend.data.contact_ids).toContain(selected);
  const original = await openHelper();
  const draft = '管理页已选择的同联系人合成草稿';
  await original.getByRole('textbox', { name: '有什么想说的', exact: true }).fill(draft);
  await original.close();
  await setVisible(true);
  const tails = await backend.tails();
  const observation = await backend.request('/api/sync/foreground/observe', {});
  expect(observation.status).toBe(200);
  expect(observation.data.phase).toBe('manual-required');
  expect(observation.data.reason).toBe('quality_unverified');
  expect(observation.data.contact_id).toBeNull();
  expect(observation.data.binding_id).toBeNull();
  expect(await backend.tails()).toEqual(tails);
  const helper = await openHelper();
  const picker = helper.getByRole('combobox', { name: '本次联系人', exact: true });
  const editor = helper.getByRole('textbox', { name: '有什么想说的', exact: true });
  await expect(picker).toHaveAttribute('data-contact-id', selected!);
  await expect(editor).toHaveValue(draft);
  // 打开helper会暂停新的前台观察；此前质量不足不能借焦点变化解除本次确认门。
  await expect.poll(() => helper.evaluate(async () => {
    const state = await window.notalone.foreground.getState();
    return { phase: state.phase, reason: state.reason, suspendedByHelperFocus: state.suspendedByHelperFocus,
      confirmation: state.confirmation, generationBlock: state.generationBlock };
  })).toEqual({ phase: 'paused', reason: 'helper_focused', suspendedByHelperFocus: true,
    confirmation: 'required', generationBlock: 'foreground-confirmation-required' });
  // 管理页选择与已有草稿都不能代替本次helper确认；不仅禁按钮，main亦须拒绝。
  const generate = helper.getByRole('button', { name: '帮我表达', exact: true });
  await expect(generate).toBeDisabled();
  expect(await helper.evaluate(async () => {
    const contact = await window.notalone.contacts.getState();
    try { await window.notalone.replies.generate({ contactId: contact.selectedContactId!, scopeRevision: contact.scopeRevision, newRequest: false }); return null; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })).toContain('请先确认本次联系人');
  await helper.getByRole('button', { name: '确认本次联系人', exact: true }).click();
  await expect(picker).toHaveAttribute('data-contact-id', selected!);
  await expect(editor).toHaveValue(draft);
  await expect(generate).toBeEnabled();
  // 恢复资格不等于已有真实候选；受控模型正向生成另按下一反馈补齐。
}
