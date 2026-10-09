import { expect, type Page } from '@playwright/test';
import type { BindingFixture } from './binding-backend-fixture';

// 首条公开red准备：尚无host/registry接线，未运行；不模拟原生焦点或权限通过。
export async function foregroundPausedWithManualDraft(helper: Page, backend: BindingFixture): Promise<void> {
  const contactId = backend.data.contact_ids[0];
  const confirmation = await backend.request('/api/sync/cli-bindings/confirm', { selections: [
    { locator: 'wxid_synthetic_a', contact_id: contactId },
  ] });
  expect(confirmation.status).toBe(200);
  expect((await backend.request('/api/sync/enable', {})).status).toBe(200);
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
  expect(report.data.wechat_in_front).toBe(false);
  expect(report.data.foreground_phase).toBe('waiting_foreground');
}
