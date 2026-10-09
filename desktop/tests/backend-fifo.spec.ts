import { expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { test as backendTest } from './backend-fixture';
import { selectMenu } from './app-fixture';

const test = backendTest.extend({ appEnvironment: async ({ backend }, use) => {
  await rm(backend.infoPath);
  await promisify(execFile)('/usr/bin/mkfifo', ['-m', '600', backend.infoPath]);
  await use({ NOTALONE_BACKEND_INFO: backend.infoPath, NOTALONE_ENV_FILE: path.join(backend.directory, 'synthetic.env'), NOTALONE_DATABASE_URL: backend.database_url });
} });

test('无写端 FIFO 握手被有界拒绝，修正后公开重试能恢复并认证退出', async ({ runningApp: { app, appProcess }, backend }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByText('本机服务连接信息无效，请检查后重试。', { exact: true })).toBeVisible({ timeout: 2000 });
  await rm(backend.infoPath);
  await backend.service.writeHandshake(backend.infoPath);
  await manager.getByRole('button', { name: '重试连接' }).click();
  await expect(manager.getByRole('status')).toContainText('已连接');
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode).toBe(0);
  expect(await backend.service.observations()).toEqual({ state: 'stopped', shutdownCount: 1, unauthorizedCount: 0 });
});

test('无写端 FIFO 未修正时也能明确退出，不关闭未验证的服务', async ({ runningApp: { app, appProcess }, backend }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByText('本机服务连接信息无效，请检查后重试。', { exact: true })).toBeVisible({ timeout: 2000 });
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode).toBe(0);
  expect(await backend.service.observations()).toEqual({ state: 'running', shutdownCount: 0, unauthorizedCount: 0 });
});
