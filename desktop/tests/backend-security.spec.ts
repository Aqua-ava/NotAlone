import { expect } from '@playwright/test';
import { chmod, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test as backendTest } from './backend-fixture';
import { selectMenu } from './app-fixture';

const invalidAddresses = ['localhost:8000', '127.0.0.1:0', '127.0.0.1:65536', '127.0.0.1:8000/path', 'example.invalid:8000'];
for (const address of invalidAddresses) {
  const test = backendTest.extend({ appEnvironment: async ({ backend }, use) => {
    await backend.service.writeHandshake(backend.infoPath, { address });
    await use({ NOTALONE_BACKEND_INFO: backend.infoPath, NOTALONE_ENV_FILE: path.join(backend.directory, 'synthetic.env') });
  } });
  test(`非法握手 ${address} 在请求前拒绝，保留安全重试入口`, async ({ runningApp: { app, appProcess }, backend }) => {
    const manager = await app.firstWindow();
    await expect(manager.getByText('本机服务连接信息无效，请检查后重试。', { exact: true })).toBeVisible();
    await expect(manager.getByRole('button', { name: '重试连接' })).toBeEnabled();
    expect(await backend.service.observations()).toEqual({ state: 'running', shutdownCount: 0, unauthorizedCount: 0 });
    await selectMenu(app, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => appProcess.exitCode).toBe(0);
  });
}

for (const kind of ['permissions', 'symlink', 'duplicate'] as const) {
  const test = backendTest.extend({ appEnvironment: async ({ backend }, use) => {
    let infoPath = backend.infoPath;
    if (kind === 'permissions') await chmod(infoPath, 0o644);
    if (kind === 'duplicate') await writeFile(infoPath, `address=${backend.service.address}\ntoken=${backend.service.token}\ntoken=synthetic-duplicate\npid=${process.pid}\n`);
    if (kind === 'symlink') {
      infoPath = path.join(backend.directory, 'linked.info');
      await symlink(backend.infoPath, infoPath);
    }
    await use({ NOTALONE_BACKEND_INFO: infoPath, NOTALONE_ENV_FILE: path.join(backend.directory, 'synthetic.env') });
  } });
  test(`握手 ${kind} 不符合受控来源要求时拒绝`, async ({ runningApp: { app }, backend }) => {
    const manager = await app.firstWindow();
    await expect(manager.getByText('本机服务连接信息无效，请检查后重试。', { exact: true })).toBeVisible();
    expect(await backend.service.observations()).toEqual({ state: 'running', shutdownCount: 0, unauthorizedCount: 0 });
  });
}

const authTest = backendTest.extend({ appEnvironment: async ({ backend }, use) => {
  await backend.service.writeHandshake(backend.infoPath, { token: 'synthetic-invalid-token' });
  await use({ NOTALONE_BACKEND_INFO: backend.infoPath, NOTALONE_ENV_FILE: path.join(backend.directory, 'synthetic.env') });
} });
authTest('认证失败不建立业务连接，修正受控握手后可重试', async ({ runningApp: { app }, backend }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByText('本机服务连接失败，请重试。', { exact: true })).toBeVisible();
  expect(await backend.service.observations()).toEqual({ state: 'running', shutdownCount: 0, unauthorizedCount: 1 });
  await backend.service.writeHandshake(backend.infoPath);
  await manager.getByRole('button', { name: '重试连接' }).click();
  await expect(manager.getByRole('status')).toContainText('已连接');
});

const pathTest = backendTest.extend({ launchConfiguration: [{ pythonExecutable: 'python', projectDirectory: '/synthetic/project' }, { option: true }] });
pathTest('相对解释器配置不能启动或建立连接，修正非秘密配置后可重试', async ({ runningApp: { app, userData }, backend }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByText('本机服务连接失败，请重试。', { exact: true })).toBeVisible();
  expect(await backend.service.observations()).toEqual({ state: 'running', shutdownCount: 0, unauthorizedCount: 0 });
  await writeFile(path.join(userData, 'backend-launch.json'), '{}');
  await manager.getByRole('button', { name: '重试连接' }).click();
  await expect(manager.getByRole('status')).toContainText('已连接');
});
