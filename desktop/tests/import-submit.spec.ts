import { test } from './import-fixture';
import { test as bootstrapTest } from './contact-fixture';
import { selectAppFile, importAppPages } from './import-app-actions';
import { savedImport, changedImport, failedImportRecovery, priorityImport, firstImportBootstrap } from './import-page-scenarios';

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
    await firstImportBootstrap(await app.firstWindow(), contactBackend, (filePath) => selectAppFile(app, filePath));
  });
});
