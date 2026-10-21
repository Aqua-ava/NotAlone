import type { ElectronApplication, Page } from '@playwright/test';
import type { ImportFixture } from './import-backend-fixture';
import { confirmImportPage, type ImportPages } from './import-page-scenarios';
export { originalImport } from './import-page-scenarios';

export async function selectAppFile(app: ElectronApplication, filePath: string): Promise<void> {
  // 只替换必要系统 I/O；实际原生对话框仍需独立实机验收。
  await app.evaluate(({ dialog }, selectedPath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] }); }, filePath);
}
export async function confirmImport(app: ElectronApplication, filePath: string, fixture: { infoPath: string }, target?: string): Promise<Page> {
  await selectAppFile(app, filePath);
  const manager = await app.firstWindow();
  await confirmImportPage(manager, fixture, target);
  return manager;
}
export async function importAppPages(app: ElectronApplication, importBackend: ImportFixture, screenshotPath?: string): Promise<ImportPages> {
  const manager = await app.firstWindow();
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
  return { manager, helper: await opened, importBackend, screenshotPath,
    chooseFile: (filePath) => selectAppFile(app, filePath) };
}
