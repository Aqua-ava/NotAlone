import { expect, type Page } from '@playwright/test';
import type { BindingFixture } from './binding-backend-fixture';

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
export async function foregroundPausedWithManualDraft(helper: Page, backend: BindingFixture): Promise<void> {
  const contactId = backend.data.contact_ids[0];
  await expect(helper.getByRole('combobox', { name: '本次联系人', exact: true })).toBeEnabled();
  await helper.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption(contactId);
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('本轮手选联系人的合成草稿');
  const locator = helper.getByRole('region', { name: '前台会话定位', exact: true });
  await expect(locator.getByText('前台定位已暂停', { exact: true })).toBeVisible();
  await expect(helper.getByRole('combobox', { name: '本次联系人', exact: true })).toHaveValue(contactId);
  await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('本轮手选联系人的合成草稿');
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
  await original.getByRole('textbox', { name: '草稿', exact: true }).fill(draft);
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
  const editor = helper.getByRole('textbox', { name: '草稿', exact: true });
  await expect(picker).toHaveValue(selected!);
  await expect(editor).toHaveValue(draft);
  const state = await helper.evaluate(async () => window.notalone.foreground.getState());
  expect(state.phase).toBe('manual-required');
  // 管理页选择与已有草稿都不能代替本次helper确认；不仅禁按钮，main亦须拒绝。
  const generate = helper.getByRole('button', { name: '生成候选', exact: true });
  await expect(generate).toBeDisabled();
  expect(await helper.evaluate(async () => {
    const contact = await window.notalone.contacts.getState();
    try { await window.notalone.replies.generate({ contactId: contact.selectedContactId!, scopeRevision: contact.scopeRevision, newRequest: false }); return null; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })).toContain('请先确认本次联系人');
  await helper.getByRole('button', { name: '确认本次联系人', exact: true }).click();
  await expect(picker).toHaveValue(selected!);
  await expect(editor).toHaveValue(draft);
  await expect(generate).toBeEnabled();
  // 恢复资格不等于已有真实候选；受控模型正向生成另按下一反馈补齐。
}
