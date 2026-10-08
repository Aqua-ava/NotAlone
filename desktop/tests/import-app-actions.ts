import { expect, type ElectronApplication, type Page } from '@playwright/test';
import type { ImportFixture } from './import-fixture';

export async function confirmImport(app: ElectronApplication, filePath: string, target?: string): Promise<Page> {
  // 只控制必要系统 I/O；资料、身份核对与保存仍经过实际 App 和真实后端。
  await app.evaluate(({ dialog }, selectedPath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] }); }, filePath);
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '历史导入', exact: true }).click();
  await manager.getByRole('button', { name: '选择历史文件', exact: true }).click();
  await manager.getByRole('combobox', { name: '资料归属联系人' }).selectOption(target ?? 'new');
  if (!target) await manager.getByRole('textbox', { name: '新联系人名称' }).fill('合成导入联系人');
  await manager.getByRole('button', { name: '预览资料范围', exact: true }).click();
  await manager.getByRole('checkbox', { name: '我已核对本人渠道身份、联系人和这份文件的资料范围' }).check();
  await manager.getByRole('button', { name: '确认本次预览', exact: true }).click();
  await expect(manager.getByText('已确认本次预览，尚未保存资料。', { exact: true })).toBeVisible();
  return manager;
}

export async function originalImport(fixture: ImportFixture) {
  const response = await fixture.request('/api/contacts');
  expect(response.status).toBe(200);
  const contact = (response.data.contacts as Array<{ contact_id: string; display_name: string }>).find((item) => item.display_name === '合成导入联系人');
  if (!contact) throw new Error('本轮合成联系人尚未保存。');
  const repeated = await fixture.request('/api/imports/commit', { path: fixture.data.file_path, contact_id: contact.contact_id });
  expect(repeated.status).toBe(200);
  return repeated.data as { contact_id: string; task_id: string };
}
