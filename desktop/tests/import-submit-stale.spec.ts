import { expect } from '@playwright/test';
import { test as importTest } from './import-fixture';
import { confirmImport } from './import-app-actions';
import { ContactHttpProxy } from './contact-http-proxy';

const test = importTest.extend<{ importProxy: ContactHttpProxy }>({
  importProxy: [async ({ importBackend }, use) => {
    const proxy = await ContactHttpProxy.attach(importBackend.infoPath, '/api/imports/commit');
    try { await use(proxy); } finally { await proxy.close(); }
  }, { auto: true }],
});

for (const failure of [false, true]) test(`停止查看后迟到的保存${failure ? '失败' : '成功'}不能恢复确认，已保存资料经真实目录核验`, async ({ runningApp: { app }, importBackend, importProxy }) => {
  const manager = await confirmImport(app, importBackend.data.file_path);
  const revision = (await manager.evaluate(() => window.notalone.imports.getState())).selectionRevision;
  importProxy.holdContacts = true;
  await manager.getByRole('button', { name: '正式导入这份资料', exact: true }).click();
  await expect.poll(() => importProxy.heldCount).toBe(1);
  await manager.getByRole('button', { name: '停止查看本次提交', exact: true }).click();
  importProxy.release(failure);
  await expect(manager.getByRole('region', { name: '本次导入处理', exact: true })).toHaveCount(0);
  await expect(manager.getByText('已确认本次预览，尚未保存资料。', { exact: true })).toHaveCount(0);
  await expect(manager.getByRole('alert')).toHaveCount(0);
  expect((await importBackend.request('/api/contacts')).data.contacts).toHaveLength(3);
  expect(await manager.evaluate(async (selectionRevision) => {
    try { await window.notalone.imports.submit({ selectionRevision }); return 'accepted'; } catch { return 'rejected'; }
  }, revision)).toBe('rejected');
});

for (const failure of [false, true]) test(`另一窗口换联系人后迟到的保存${failure ? '失败' : '成功'}不污染当前范围`, async ({ runningApp: { app }, importBackend, importProxy }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
  const helper = await opened;
  await confirmImport(app, importBackend.data.file_path);
  importProxy.holdContacts = true;
  await manager.getByRole('button', { name: '正式导入这份资料', exact: true }).click();
  await expect.poll(() => importProxy.heldCount).toBe(1);
  await helper.getByRole('combobox', { name: '本次联系人' }).selectOption(importBackend.data.contact_ids[1]);
  importProxy.release(failure);
  await expect(manager.getByText('尚未选择文件', { exact: true })).toBeVisible();
  await expect(manager.getByRole('region', { name: '本次导入处理', exact: true })).toHaveCount(0);
  await expect(manager.getByRole('alert')).toHaveCount(0);
  await expect(helper.getByText('本次联系人：合成联系人乙', { exact: true })).toBeVisible();
});

for (const failure of [false, true]) test(`换连接后迟到的保存${failure ? '失败' : '成功'}不恢复原任务页面`, async ({ runningApp: { app }, importBackend, importProxy }) => {
  const manager = await confirmImport(app, importBackend.data.file_path);
  importProxy.holdContacts = true;
  await manager.getByRole('button', { name: '正式导入这份资料', exact: true }).click();
  await expect.poll(() => importProxy.heldCount).toBe(1);
  importProxy.failRuntimeStatus = true;
  await expect(manager.getByText('本机服务尚未连接', { exact: true })).toBeVisible();
  await importBackend.command('restart');
  await manager.getByRole('button', { name: '重试连接', exact: true }).click();
  await expect(manager.getByText('本机服务已连接', { exact: true })).toBeVisible();
  importProxy.release(failure);
  await expect(manager.getByText('尚未选择文件', { exact: true })).toBeVisible();
  await expect(manager.getByRole('region', { name: '本次导入处理', exact: true })).toHaveCount(0);
  await expect(manager.getByRole('alert')).toHaveCount(0);
  expect((await importBackend.request('/api/contacts')).data.contacts).toHaveLength(3);
});

test('保存响应丢失不假称回滚或自动重发，重新预览确认后恢复同一真实来源', async ({ runningApp: { app }, importBackend, importProxy }) => {
  const manager = await confirmImport(app, importBackend.data.file_path);
  importProxy.holdContacts = true;
  await manager.getByRole('button', { name: '正式导入这份资料', exact: true }).click();
  await expect.poll(() => importProxy.heldCount).toBe(1);
  importProxy.holdContacts = false;
  importProxy.release(true);
  await expect(manager.getByRole('alert')).toContainText('本次保存结果尚未确认');
  await expect(manager.getByRole('region', { name: '本次导入处理', exact: true })).toHaveCount(0);
  const before = await importBackend.request('/api/contacts');
  expect(before.data.contacts).toHaveLength(3);
  await confirmImport(app, importBackend.data.file_path);
  await manager.getByRole('button', { name: '正式导入这份资料', exact: true }).click();
  await expect(manager.getByText('新增 0 条消息，已存在 6 条消息。', { exact: true })).toBeVisible();
  expect(await importBackend.request('/api/contacts')).toEqual(before);
});
