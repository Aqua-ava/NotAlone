import { expect } from '@playwright/test';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { projectDirectory, pythonExecutable, test } from './startup-fixture';

for (const [condition, message] of [
  ['unavailable', '项目目录不可用。'],
  ['missing-source', '后端包或必要依赖缺失。'],
] as const) {
  const pathTest = test.extend({
    databaseState: 'ready',
    launchConfiguration: async ({ startupDatabase }, use) => {
      const selected = path.join(startupDatabase.directory, condition);
      if (condition === 'missing-source') await mkdir(selected);
      await use({ pythonExecutable, projectDirectory: selected });
    },
  });
  pathTest(`项目 ${condition} 显示对应原因，修正项目路径后公开重试恢复`, async ({ runningApp: { app, userData } }) => {
    const manager = await app.firstWindow();
    await manager.getByRole('button', { name: '应用配置', exact: true }).click();
    await expect(manager.getByText(message, { exact: true })).toBeVisible();
    expect(await access(path.join(userData, 'backend.info')).then(() => true, () => false)).toBe(false);
    await manager.getByLabel('项目目录', { exact: true }).fill(projectDirectory);
    await manager.getByRole('button', { name: '保存启动路径', exact: true }).click();
    await expect(manager.getByText('启动路径已保存。请重新检查并连接。', { exact: true })).toBeVisible();
    await manager.getByRole('button', { name: '重新检查并连接', exact: true }).click();
    await expect(manager.getByText('机器环境已就绪。', { exact: true })).toBeVisible();
    await expect(manager.getByText('已连接', { exact: true })).toBeVisible({ timeout: 15_000 });
    await manager.screenshot({ path: pathTest.info().outputPath('project-path-restored.png') });
  });
}
