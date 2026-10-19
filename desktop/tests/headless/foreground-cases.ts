import { expect, type Browser, type Page } from '@playwright/test';
import { access, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PageHost } from './page-host';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { withPausedForegroundFixture, withManualForegroundFixture, withContinuousForegroundFixture } from '../foreground-backend-fixture';
import { initialCliState, type BindingFixture } from '../binding-backend-fixture';
import { ContactHttpProxy } from '../contact-http-proxy';
import { fillWorkspaceInstruction } from '../workspace-actions';
import { foregroundObservationPaused, foregroundPausedWithManualDraft, foregroundManualConfirmation } from '../foreground-page-scenarios';

async function awaitAuthorizedSync(backend: BindingFixture, priorityContactId: string | null): Promise<void> {
  // 开关补齐和查看联系人优先读取是已授权后台工作，必须先取得公开完成回执再测纯定位。
  await expect.poll(async () => {
    const response = await backend.request('/api/sync/status');
    const report = response.data;
    return { status: response.status, enabled: report.sync_enabled, pending: report.cli_pending_count,
      backfill: report.cli_backfill_phase, total: report.cli_backfill_total_contacts,
      completed: report.cli_backfill_completed_contacts, failure: report.cli_backfill_failure_code,
      priority: report.cli_priority_contact_id,
      priorityFinished: priorityContactId === null || typeof report.cli_priority_last_success_at === 'string',
      priorityFailure: report.cli_priority_last_failure_code };
  }).toEqual({ status: 200, enabled: true, pending: 0, backfill: 'complete', total: 1, completed: 1,
    failure: null, priority: priorityContactId, priorityFinished: true, priorityFailure: null });
}

async function observeWithoutBodyReads(backend: BindingFixture) {
  const before = await backend.tails();
  const observation = await backend.request('/api/sync/foreground/observe', {});
  expect(await backend.tails()).toEqual(before);
  return observation;
}

export async function withForegroundPages(browser: Browser, origin: string, fixture: BindingFixture,
  use: (manager: Page, openHelper: () => Promise<Page>, host: PageHost) => Promise<void>): Promise<void> {
  await withControllerEnvironment(fixture, async (userData) => {
    const host = new PageHost(await browser.newContext(), origin, userData);
    try {
      await host.backend.connect();
      const manager = await host.open('manager');
      await use(manager, async () => {
        const opened = manager.context().waitForEvent('page');
        await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
        const helper = await opened;
        await helper.waitForURL(`${origin}/#helper`);
        await host.awaitPendingWindowCommands();
        return helper;
      }, host);
    } finally {
      try { await host.close(); fixture.confirmControllerStopped(); }
      catch (error) { fixture.recordUnconfirmedCleanup('page-host'); throw error; }
    }
  });
}

// 首片公开入口：真实认证HTTP/PG和生产页面；只替换外部定位probe输入。
export async function foregroundPaused(browser: Browser, origin: string): Promise<void> {
  const name = '前台新观察暂停且手选草稿保留、CLI同步独立';
  process.stdout.write(`page_test_scenario: ${name}\n`);
  const released = ownResource();
  await withPausedForegroundFixture(async (fixture) => {
    await foregroundObservationPaused(fixture);
    await withForegroundPages(browser, origin, fixture, async (manager, openHelper) => {
      await foregroundPausedWithManualDraft(manager, await openHelper(), fixture);
    });
  }, released);
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}

// 公开人工确认场景：仅公共HTTP、页面和合成probe，验证本次helper确认门禁。
export async function foregroundManual(browser: Browser, origin: string): Promise<void> {
  const name = '缺少定位质量时保留草稿且需本次helper确认才能生成';
  process.stdout.write(`page_test_scenario: ${name}\n`);
  const released = ownResource();
  await withManualForegroundFixture(async ({ backend, setVisible }) => {
    await foregroundObservationPaused(backend);
    await withForegroundPages(browser, origin, backend, async (manager, openHelper) => {
      await foregroundManualConfirmation(manager, openHelper, backend, setVisible);
    });
  }, released, 'single-account');
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}

// 真实HTTP/PG接缝：高质量输入仅允许当前账号唯一active绑定返回身份。
export async function foregroundVerified(browser: Browser, origin: string): Promise<void> {
  const name = '合格新观察返回唯一已确认绑定且不读取正文';
  process.stdout.write(`page_test_scenario: ${name}\n`);
  const released = ownResource();
  await withContinuousForegroundFixture(async (backend) => {
    const state = initialCliState();
    state.sessions[0].display_name = '唯一合成会话';
    await backend.setCli(state);
    const contactId = backend.data.contact_ids[0];
    const confirmation = await backend.request('/api/sync/cli-bindings/confirm', { selections: [
      { locator: 'wxid_synthetic_a', contact_id: contactId },
    ] });
    expect(confirmation.status).toBe(200);
    expect((await backend.request('/api/sync/enable', {})).status).toBe(200);
    const bindings = await backend.request('/api/sync/cli-bindings');
    expect(bindings.status).toBe(200);
    const active = (bindings.data.bindings as { binding_id: string; contact_id: string }[])
      .find((item) => item.contact_id === contactId)!;
    expect(active).toBeDefined();
    await awaitAuthorizedSync(backend, null);
    const tails = await backend.tails();
    const observed = await backend.request('/api/sync/foreground/observe', {});
    expect(observed.status).toBe(200);
    expect(observed.data.phase).toBe('confirmed');
    expect(observed.data.reason).toBe('confirmed_active_binding');
    expect(observed.data.binding_id).toBe(active.binding_id);
    expect(observed.data.contact_id).toBe(contactId);
    expect(Object.keys(observed.data).sort()).toEqual(['binding_id', 'contact_id', 'observation_id', 'observed_at',
      'phase', 'probe_available', 'reason', 'wechat_in_front']);
    expect(await backend.tails()).toEqual(tails);
    const proxy = await ContactHttpProxy.attach(backend.infoPath);
    try {
      await withForegroundPages(browser, origin, backend, async (manager, openHelper) => {
        const expectConfirmedHelper = async (page: Page, stage: string) => {
          try {
            await expect(page.getByText('本次联系人已通过微信会话绑定确认。', { exact: true }), stage).toBeVisible();
          } catch (error) {
            const foreground = await page.evaluate(async () => {
              const value = await window.notalone.foreground.getState();
              return { phase: value.phase, reason: value.reason, generationBlock: value.generationBlock,
                confirmation: value.confirmation, suspendedByHelperFocus: value.suspendedByHelperFocus };
            });
            const response = await backend.request('/api/sync/cli-bindings');
            const bindings = response.data.bindings as { binding_id: string; status: string }[];
            process.stdout.write(`foreground_confirmation_diagnostic: ${JSON.stringify({ stage, foreground,
              bindingsStatus: response.status, expectedBindingStatus: bindings.find(item => item.binding_id === active.binding_id)?.status ?? null })}\n`);
            throw error;
          }
        };
        await expect(manager.getByRole('region', { name: '联系人目录', exact: true })
          .getByRole('button', { name: /^选择/ }).first()).toBeVisible();
        const helper = await openHelper();
        await expect(helper.getByRole('combobox', { name: '本次联系人', exact: true })).toHaveValue(contactId);
        await expectConfirmedHelper(helper, 'initial-helper');
        await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('唯一绑定下的合成草稿');
        await expect(helper.getByRole('button', { name: '帮我表达', exact: true })).toBeEnabled();
        await manager.evaluate(async () => {
          await window.notalone.syncControl.refresh();
          const state = await window.notalone.syncControl.getState();
          await window.notalone.syncControl.disable({ scopeRevision: state.scopeRevision });
        });
        await expect(helper.getByRole('button', { name: '帮我表达', exact: true })).toBeDisabled();
        await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('唯一绑定下的合成草稿');
        await manager.evaluate(async () => {
          const state = await window.notalone.syncControl.getState();
          await window.notalone.syncControl.enable({ scopeRevision: state.scopeRevision });
        });
        await expect(helper.getByRole('button', { name: '帮我表达', exact: true })).toBeDisabled();
        await awaitAuthorizedSync(backend, contactId);
        // 重新开启允许已确认CLI范围补齐；完成后的独立定位仍不得读取正文。
        expect((await observeWithoutBodyReads(backend)).data.contact_id).toBe(contactId);
        await helper.close();
        const restored = await openHelper();
        const picker = restored.getByRole('combobox', { name: '本次联系人', exact: true });
        const editor = restored.getByRole('textbox', { name: '有什么想说的', exact: true });
        await expect(picker).toHaveValue(contactId);
        await expect(editor).toHaveValue('唯一绑定下的合成草稿');
        await expectConfirmedHelper(restored, 'reenabled-helper');
        await expect(editor).toHaveValue('唯一绑定下的合成草稿');
        const otherContact = backend.data.contact_ids[1];
        // 无绑定的B只经管理页选择本地草稿范围，不能借helper渠道确认获得生成资格。
        await manager.evaluate(async contactId => {
          const state = await window.notalone.contacts.getState();
          await window.notalone.contacts.selectContact({ contactId, scopeRevision: state.scopeRevision });
        }, otherContact);
        await expect.poll(() => restored.evaluate(async () =>
          (await window.notalone.contacts.getState()).selectedContactId)).toBe(otherContact);
        await awaitAuthorizedSync(backend, null);
        await editor.fill('另一联系人的合成草稿');
        await expect(restored.getByRole('button', { name: '帮我表达', exact: true })).toBeDisabled();
        await expect(restored.getByRole('button', { name: '帮我想想', exact: true })).toBeDisabled();
        expect(await restored.evaluate(async () => {
          const contact = await window.notalone.contacts.getState();
          try {
            await window.notalone.replies.generate({ contactId: contact.selectedContactId!, scopeRevision: contact.scopeRevision,
              newRequest: true, workspaceAction: 'express' });
            return 'accepted';
          } catch (error) { return error instanceof Error ? error.message : String(error); }
        })).toContain('请先确认本次联系人');
        await expect.poll(() => restored.evaluate(async () =>
          (await window.notalone.contacts.getState()).draft)).toBe('另一联系人的合成草稿');
        await restored.close();
        const different = await openHelper();
        await expect(different.getByRole('combobox', { name: '本次联系人', exact: true })).toHaveValue(contactId);
        await expect(different.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('唯一绑定下的合成草稿');
        await expect(different.getByRole('button', { name: '帮我表达', exact: true })).toBeEnabled();
        await awaitAuthorizedSync(backend, contactId);
        const afterSwitch = await observeWithoutBodyReads(backend);
        expect(afterSwitch.data).toMatchObject({ phase: 'confirmed', contact_id: contactId, binding_id: active.binding_id });
        const instruction = different.getByRole('textbox', { name: '本次要求', exact: true });
        await fillWorkspaceInstruction(different, '正在编辑的合成要求');
        await expect.poll(() => different.evaluate(async () =>
          (await window.notalone.replies.getState()).options.instruction)).toBe('正在编辑的合成要求');
        const managerOpened = different.context().waitForEvent('page');
        await different.getByRole('button', { name: '打开管理后台', exact: true }).click();
        await (await managerOpened).waitForURL(`${origin}/#manager`);
        const hold = path.join(backend.directory, 'hold-sessions');
        await writeFile(hold, '', { mode: 0o600 });
        const nextHelper = openHelper();
        await expect.poll(async () => {
          try { await access(path.join(backend.directory, 'held-sessions-ready')); return true; }
          catch { return false; }
        }).toBe(true);
        await instruction.fill('');
        await expect.poll(() => different.evaluate(async () =>
          (await window.notalone.replies.getState()).options.instruction)).toBe('');
        await rm(hold);
        const late = await nextHelper;
        const lateState = await late.evaluate(async () => window.notalone.foreground.getState());
        expect(lateState.phase).not.toBe('confirmed');
        expect(lateState.suspendedByHelperFocus).toBe(true);
        proxy.holdRequestPaths.add('/api/sync/disable');
        const disable = manager.evaluate(async () => {
          await window.notalone.syncControl.refresh();
          const state = await window.notalone.syncControl.getState();
          await window.notalone.syncControl.disable({ scopeRevision: state.scopeRevision });
        });
        try {
          await expect.poll(() => proxy.heldCount).toBe(1);
          await late.close();
          const duringChange = await openHelper();
          const readingScope = await duringChange.evaluate(async () => window.notalone.foreground.getState());
          expect(readingScope.suspendedByHelperFocus).toBe(true);
          expect(readingScope.generationBlock).toBe('foreground-confirmation-required');
          await duringChange.close();
        } finally { proxy.holdRequestPaths.clear(); proxy.release(); }
        await disable;
        await manager.evaluate(async () => {
          const state = await window.notalone.syncControl.getState();
          await window.notalone.syncControl.enable({ scopeRevision: state.scopeRevision });
        });
        await awaitAuthorizedSync(backend, contactId);
        for (const chatType of ['private', 'group']) {
          state.sessions[1].display_name = '唯一合成会话';
          state.sessions[1].chat_type = chatType;
          await backend.setCli(state);
          const duplicate = await observeWithoutBodyReads(backend);
          expect(duplicate.status).toBe(200);
          // 私聊重名要求手动选择；同名群聊会暂停定位，不能借私聊绑定授予身份。
          expect({ phase: duplicate.data.phase, reason: duplicate.data.reason }, `duplicate-${chatType}`)
            .toEqual(chatType === 'group'
              ? { phase: 'paused', reason: 'group_chat_suspected' }
              : { phase: 'manual-required', reason: 'ambiguous_requires_selection' });
          expect(duplicate.data.binding_id).toBeNull();
          expect(duplicate.data.contact_id).toBeNull();
        }
        state.sessions[1].display_name = '另一合成会话';
        state.sessions[0].display_name = '已改名合成会话';
        await backend.setCli(state);
        const renamed = await observeWithoutBodyReads(backend);
        expect(renamed.data.phase, `renamed: phase=${renamed.data.phase}, reason=${renamed.data.reason}`)
          .toBe('manual-required');
        expect(renamed.data.contact_id).toBeNull();
        state.sessions[0].display_name = '唯一合成会话';
        await backend.setCli(state);
        const beforeRevoke = await openHelper();
        await expectConfirmedHelper(beforeRevoke, 'restored-name-before-revoke');
        await beforeRevoke.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('解绑时保留的合成草稿');
        await expect(beforeRevoke.getByRole('button', { name: '帮我表达', exact: true })).toBeEnabled();
        await manager.evaluate(async ({ contactId, bindingId }) => {
          await window.notalone.bindings.refresh();
          const state = await window.notalone.bindings.getState();
          await window.notalone.bindings.revokeBinding({ scopeRevision: state.scopeRevision, contactId, bindingId });
        }, { contactId, bindingId: active.binding_id });
        await expect(beforeRevoke.getByRole('button', { name: '帮我表达', exact: true })).toBeDisabled();
        await expect(beforeRevoke.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('解绑时保留的合成草稿');
        const revoked = await observeWithoutBodyReads(backend);
        expect(revoked.data.phase, `revoked: phase=${revoked.data.phase}, reason=${revoked.data.reason}`)
          .toBe('manual-required');
        expect(revoked.data.binding_id).toBeNull();
        expect(revoked.data.contact_id).toBeNull();
      });
    } finally {
      try { await proxy.close(); }
      catch (error) { backend.recordUnconfirmedCleanup('http-proxy'); throw error; }
    }
  }, released);
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}
