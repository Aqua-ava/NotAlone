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
