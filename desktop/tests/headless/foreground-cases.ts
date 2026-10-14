import { expect, type Browser, type Page } from '@playwright/test';
import { access, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PageHost } from './page-host';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { withPausedForegroundFixture, withManualForegroundFixture, withContinuousForegroundFixture } from '../foreground-backend-fixture';
import { initialCliState, type BindingFixture } from '../binding-backend-fixture';
import { ContactHttpProxy } from '../contact-http-proxy';
import { foregroundObservationPaused, foregroundPausedWithManualDraft, foregroundManualConfirmation } from '../foreground-page-scenarios';

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
    await withForegroundPages(browser, origin, fixture, async (_manager, openHelper) => {
      await foregroundPausedWithManualDraft(await openHelper(), fixture);
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
  }, released);
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
    let tails = await backend.tails();
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
        await expect(manager.getByRole('region', { name: '联系人目录', exact: true })
          .getByRole('button', { name: /^选择/ }).first()).toBeVisible();
        const helper = await openHelper();
        await expect(helper.getByRole('combobox', { name: '本次联系人', exact: true })).toHaveValue(contactId);
        await expect(helper.getByText('本次联系人已通过微信会话绑定确认。', { exact: true })).toBeVisible();
        await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('唯一绑定下的合成草稿');
        await expect(helper.getByRole('button', { name: '生成候选', exact: true })).toBeEnabled();
        await manager.evaluate(async () => {
          await window.notalone.syncControl.refresh();
          const state = await window.notalone.syncControl.getState();
          await window.notalone.syncControl.disable({ scopeRevision: state.scopeRevision });
        });
        await expect(helper.getByRole('button', { name: '生成候选', exact: true })).toBeDisabled();
        await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('唯一绑定下的合成草稿');
        await manager.evaluate(async () => {
          const state = await window.notalone.syncControl.getState();
          await window.notalone.syncControl.enable({ scopeRevision: state.scopeRevision });
        });
        await expect(helper.getByRole('button', { name: '生成候选', exact: true })).toBeDisabled();
        // 重新开启允许已确认CLI范围补齐；后续定位观察从此水位证明不新增正文读取。
        tails = await backend.tails();
        expect(await backend.tails()).toEqual(tails);
        await helper.close();
        const restored = await openHelper();
        const picker = restored.getByRole('combobox', { name: '本次联系人', exact: true });
        const editor = restored.getByRole('textbox', { name: '草稿', exact: true });
        await expect(picker).toHaveValue(contactId);
        await expect(editor).toHaveValue('唯一绑定下的合成草稿');
        await expect(restored.getByText('本次联系人已通过微信会话绑定确认。', { exact: true })).toBeVisible();
        await expect(editor).toHaveValue('唯一绑定下的合成草稿');
        const otherContact = backend.data.contact_ids[1];
        await picker.selectOption(otherContact);
        await expect.poll(() => restored.evaluate(async () =>
          (await window.notalone.contacts.getState()).selectedContactId)).toBe(otherContact);
        await editor.fill('另一联系人的合成草稿');
        await expect.poll(() => restored.evaluate(async () =>
          (await window.notalone.contacts.getState()).draft)).toBe('另一联系人的合成草稿');
        await restored.close();
        const different = await openHelper();
        await expect(different.getByRole('combobox', { name: '本次联系人', exact: true })).toHaveValue(contactId);
        await expect(different.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('唯一绑定下的合成草稿');
        await expect(different.getByRole('button', { name: '生成候选', exact: true })).toBeEnabled();
        expect(await backend.tails()).toEqual(tails);
        const instruction = different.getByRole('textbox', { name: '本次要求', exact: true });
        await instruction.fill('正在编辑的合成要求');
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
        tails = await backend.tails();
        for (const chatType of ['private', 'group']) {
          state.sessions[1].display_name = '唯一合成会话';
          state.sessions[1].chat_type = chatType;
          await backend.setCli(state);
          const duplicate = await backend.request('/api/sync/foreground/observe', {});
          expect(duplicate.status).toBe(200);
          expect(duplicate.data.phase).toBe('manual-required');
          expect(duplicate.data.binding_id).toBeNull();
          expect(duplicate.data.contact_id).toBeNull();
          expect(await backend.tails()).toEqual(tails);
        }
        state.sessions[1].display_name = '另一合成会话';
        state.sessions[0].display_name = '已改名合成会话';
        await backend.setCli(state);
        const renamed = await backend.request('/api/sync/foreground/observe', {});
        expect(renamed.data.phase).toBe('manual-required');
        expect(renamed.data.contact_id).toBeNull();
        state.sessions[0].display_name = '唯一合成会话';
        await backend.setCli(state);
        const beforeRevoke = await openHelper();
        await expect(beforeRevoke.getByText('本次联系人已通过微信会话绑定确认。', { exact: true })).toBeVisible();
        await beforeRevoke.getByRole('textbox', { name: '草稿', exact: true }).fill('解绑时保留的合成草稿');
        await expect(beforeRevoke.getByRole('button', { name: '生成候选', exact: true })).toBeEnabled();
        await manager.evaluate(async ({ contactId, bindingId }) => {
          await window.notalone.bindings.refresh();
          const state = await window.notalone.bindings.getState();
          await window.notalone.bindings.revokeBinding({ scopeRevision: state.scopeRevision, contactId, bindingId });
        }, { contactId, bindingId: active.binding_id });
        await expect(beforeRevoke.getByRole('button', { name: '生成候选', exact: true })).toBeDisabled();
        await expect(beforeRevoke.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('解绑时保留的合成草稿');
        const revoked = await backend.request('/api/sync/foreground/observe', {});
        expect(revoked.data.phase).toBe('manual-required');
        expect(revoked.data.binding_id).toBeNull();
        expect(revoked.data.contact_id).toBeNull();
        expect(await backend.tails()).toEqual(tails);
      });
    } finally {
      try { await proxy.close(); }
      catch (error) { backend.recordUnconfirmedCleanup('http-proxy'); throw error; }
    }
  }, released);
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}
