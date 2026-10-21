import { selectContact } from './contact-picker-actions.mjs';
import { randomUUID } from 'node:crypto';
import { requestFixtureHttp } from './fixture-transport';
import { expect, type Page } from '@playwright/test';

export async function openFileImport(manager: Page): Promise<void> {
  const navigation = manager.getByRole('navigation', { name: '管理导航' });
  await expect(navigation.getByRole('button', { name: /历史导入|从文件导入/ })).toHaveCount(0);
  await navigation.getByRole('button', { name: '设置', exact: true }).click();
  const advanced = manager.locator('details').filter({ has: manager.locator('summary', { hasText: '高级' }) });
  if (await advanced.getAttribute('open') === null) await advanced.locator(':scope > summary').click();
  await advanced.getByRole('button', { name: '从文件导入', exact: true }).click();
  await expect(manager.getByRole('heading', { name: '从文件导入', exact: true })).toBeVisible();
  await expect(navigation.getByRole('button', { name: '设置', exact: true })).toHaveAttribute('aria-current', 'page');
}

// 联系人由隔离测试后端预置；产品页面只负责选择已有联系人和确认导入归属。
export async function seedImportContact(manager: Page, displayName: string, fixture: { infoPath: string }): Promise<void> {
  const directory = await requestFixtureHttp(fixture.infoPath, '/api/contacts');
  expect(directory.status).toBe(200);
  const contacts = directory.data.contacts as Array<{ display_name: string }>;
  if (!contacts.some(contact => contact.display_name === displayName)) {
    const created = await requestFixtureHttp(fixture.infoPath, '/api/contacts', { request_id: randomUUID(), display_name: displayName });
    expect(created.status).toBe(201);
  }
  await manager.evaluate(() => window.notalone.contacts.refreshContacts());
}

export async function prepareImportContact(manager: Page, displayName: string, fixture: { infoPath: string }): Promise<void> {
  await seedImportContact(manager, displayName, fixture);
  await manager.getByRole('button', { name: '联系人', exact: true }).click();
  await expect(manager.getByRole('button', { name: '创建联系人', exact: true })).toHaveCount(0);
  await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: displayName });
}
