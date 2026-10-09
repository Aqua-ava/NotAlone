import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from './import-fixture';
import { test as bootstrapTest } from './contact-fixture';
import { confirmImport, importAppPages } from './import-app-actions';
import { savedImport, changedImport, failedImportRecovery, priorityImport } from './import-page-scenarios';

test('正式导入刷新真实联系人来源并核验五步，同一联系人重复导入复用原任务', async ({ runningApp: { app }, importBackend }) => {
  await savedImport(await importAppPages(app, importBackend, test.info().outputPath('import-task-completed.png')));
});

test('确认后文件变化在正式保存时拒绝，失败不能复用旧确认或带任意路径', async ({ runningApp: { app }, importBackend }) => {
  await changedImport(await importAppPages(app, importBackend, test.info().outputPath('import-task-completed.png')));
});

test('真实模型失败显示原步骤，重试只恢复失败任务并保留成功步骤', async ({ runningApp: { app }, importBackend }) => {
  await failedImportRecovery(await importAppPages(app, importBackend, test.info().outputPath('import-task-completed.png')));
});

test('导入后台模型等待时小窗仍能发起当前已绑定联系人的候选，前台生成期间后台让位', async ({ runningApp: { app }, importBackend }) => {
  await priorityImport(await importAppPages(app, importBackend, test.info().outputPath('import-task-completed.png')));
});

bootstrapTest.describe('首份渠道身份重装配', () => {
  bootstrapTest.use({ databaseMode: 'empty' });
  bootstrapTest('首份导入后用户明确认证停读重启装配 SyncHost，导入不新增同步授权', async ({ runningApp: { app }, contactBackend }) => {
    const filePath = path.join(contactBackend.directory, 'first-owner.jsonl');
    await writeFile(filePath, await readFile(path.resolve('../backend/tests/fixtures/valid_single_contact.jsonl')));
    const manager = await confirmImport(app, filePath);
    await manager.getByRole('button', { name: '正式导入这份资料', exact: true }).click();
    await expect(manager.getByText('新增 6 条消息，已存在 0 条消息。', { exact: true })).toBeVisible();
    const reload = manager.getByRole('button', { name: '认证停读并重新加载同步服务', exact: true });
    await expect(reload).toBeEnabled();
    const before = await readFile(contactBackend.infoPath, 'utf8');
    await reload.click();
    await expect(manager.getByText('同步服务已重新加载。请在同步设置中主动选择并确认会话授权；如需查看原导入任务，请重新预览确认同一份文件。', { exact: true })).toBeVisible({ timeout: 20_000 });
    expect(await readFile(contactBackend.infoPath, 'utf8')).not.toBe(before);
    expect((await contactBackend.request('/api/sync/cli-bindings' as '/api/contacts')).data.bindings).toEqual([]);
    expect((await contactBackend.request('/api/contacts')).data.contacts).toHaveLength(1);
  });
});
