import { expect } from '@playwright/test';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { selectMenu } from './app-fixture';
import { test as backendTest } from './backend-fixture';
import { SetupFixture } from './setup-fixture';
import { SetupHttpProxy } from './setup-http-proxy';
import { prepareDatabase, projectDirectory, test as startupTest } from './startup-fixture';

const test = startupTest.extend<{ machineSetup: { setup: SetupFixture; proxy: SetupHttpProxy } }>({
  databaseState: 'ready',
  machineSetup: async ({ startupDatabase }, use) => {
    const setup = new SetupFixture(startupDatabase.directory, startupDatabase.database);
    await setup.prepareInterpreter();
    setup.reusedBackend = await setup.startBackend();
    const proxy = await SetupHttpProxy.attach(setup.infoPath);
    try { await use({ setup, proxy }); }
    finally { await proxy.close(); await setup.cleanup(); }
  },
  appEnvironment: async ({ machineSetup }, use) => {
    await use({ ...machineSetup.setup.environment(), PATH: '/usr/bin:/bin', CONDA_PREFIX: '', CONDA_DEFAULT_ENV: '',
      PYTHONPATH: '/synthetic/unavailable' });
  },
  launchConfiguration: async ({ machineSetup }, use) => {
    const setup = machineSetup.setup;
    await use({ pythonExecutable: setup.pythonPath, projectDirectory, envFilePath: setup.envPath, backendInfoPath: setup.infoPath });
  },
});

test('本人初始化后的正常重启仍检查机器账本，修正后明确加载配置恢复', async ({ runningApp: { app }, startupDatabase, machineSetup: { setup, proxy } }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '应用配置', exact: true }).click();
  const panel = manager.getByRole('region', { name: '本人身份与模型' });
  await expect(manager.getByText('机器环境已就绪。', { exact: true })).toBeVisible();
  await expect(panel.getByText('本人身份尚未初始化', { exact: true })).toBeVisible({ timeout: 15_000 });
  proxy.closeAfterShutdown = true;
  proxy.afterShutdown = async () => {
    await setup.waitForExit(setup.reusedBackend!);
    await prepareDatabase('drift', startupDatabase.database);
  };
  await panel.getByRole('textbox', { name: '本人展示名称' }).fill('机器门禁合成本人');
  await panel.getByRole('button', { name: '初始化本人', exact: true }).click();
  await expect(manager.getByText('数据库迁移账本或基线发生漂移。', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText('后端重启未获确认。请检查受控配置后重试加载。', { exact: true })).toBeVisible();
  expect(await access(setup.infoPath).then(() => true, () => false)).toBe(false);
  const saved = await readFile(setup.envPath);
  await prepareDatabase('restore-drift', startupDatabase.database);
  await panel.getByRole('button', { name: '重试加载配置', exact: true }).click();
  await expect(panel.getByText('本次运行的本人身份已就绪', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(manager.getByText('机器环境已就绪。', { exact: true })).toBeVisible();
  expect((await setup.request('/api/setup/status')).data.runtime_owner_configured).toBe(true);
  expect((await readFile(setup.envPath)).equals(saved)).toBe(true);
  expect(proxy.initializeCompletedCount).toBe(1);
  await manager.getByRole('region', { name: '机器环境诊断' }).screenshot({ path: test.info().outputPath('machine-gate-restored.png') });
});

const driftTest = test.extend({ databaseState: 'drift' });
driftTest('合法既有后端也须通过机器门禁，阻塞时不把运行连接当作数据库就绪', async ({ runningApp: { app, appProcess }, startupDatabase, machineSetup: { setup, proxy } }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '应用配置', exact: true }).click();
  await expect(manager.getByText('数据库迁移账本或基线发生漂移。', { exact: true })).toBeVisible();
  await expect(manager.getByText('尚未连接', { exact: true })).toBeVisible();
  expect((await setup.request('/api/runtime/status')).data.state).toBe('running');
  await prepareDatabase('restore-drift', startupDatabase.database);
  await manager.getByRole('button', { name: '重新检查并连接', exact: true }).click();
  await expect(manager.getByText('已验证既有运行时。', { exact: true })).toBeVisible({ timeout: 15_000 });
  proxy.closeAfterShutdown = true;
  proxy.afterShutdown = () => setup.waitForExit(setup.reusedBackend!);
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode).toBe(0);
  await expect.poll(() => setup.reusedBackend?.exitCode).toBe(0);
});

backendTest('路径修改未确认停读时保留旧目标，拒绝保存和另起连接', async ({ runningApp: { app, appProcess, userData }, backend }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByText('已连接', { exact: true })).toBeVisible();
  await manager.getByRole('button', { name: '应用配置', exact: true }).click();
  const before = await readFile(path.join(userData, 'backend-launch.json'));
  backend.service.shutdownMode = 'failure';
  await manager.getByRole('button', { name: '停止服务以修改路径', exact: true }).click();
  await expect(manager.getByText('服务停读未获确认，暂时不能修改路径。请按连接状态中的入口恢复。', { exact: true })).toBeVisible();
  await expect(manager.getByLabel('后端握手文件', { exact: true })).toBeDisabled();
  const refused = await manager.evaluate(async () => {
    const paths = await window.notalone.startup.getPaths();
    try { await window.notalone.startup.savePaths({ ...paths, backendInfoPath: `${paths.backendInfoPath}.replacement` }); return false; }
    catch { return true; }
  });
  expect(refused).toBe(true);
  expect((await readFile(path.join(userData, 'backend-launch.json'))).equals(before)).toBe(true);
  await manager.evaluate(() => window.notalone.startup.retry());
  expect((await backend.service.observations()).shutdownCount).toBe(1);
  backend.service.shutdownMode = 'success';
  await manager.getByRole('button', { name: '重试停读并退出', exact: true }).click();
  await expect.poll(() => appProcess.exitCode).toBe(0);
  expect((await backend.service.observations()).shutdownCount).toBe(2);
});
