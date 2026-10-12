import { expect } from '@playwright/test';
import { selectMenu } from './app-fixture';
import { SyntheticBackend, test } from './backend-fixture';
import { spawnApp } from './app-test-gate';
import path from 'node:path';

test('App 认证复用本机服务，双窗口共享真实连接，退出确认停读', async ({ runningApp: { app, appProcess }, backend }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByRole('status')).toContainText('已连接');
  await expect(manager.getByText('已验证既有运行时。', { exact: true })).toBeVisible();
  const helperOpened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗' }).click();
  const helper = await helperOpened;
  await expect(helper.getByRole('status').filter({ hasText: /^已连接$/ })).toBeVisible();
  await helper.getByRole('button', { name: '隐藏输入小窗' }).click();
  expect((await backend.service.observations()).state).toBe('running');
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode).toBe(0);
  expect(await backend.service.observations()).toEqual({ state: 'stopped', shutdownCount: 1, unauthorizedCount: 0 });
});

for (const mode of ['failure', 'timeout'] as const) {
  test(`停读${mode === 'failure' ? '失败' : '超时'}保留真实失败与重试入口，重复退出不重复关闭`, async ({ runningApp: { app, appProcess }, backend }) => {
    const manager = await app.firstWindow();
    await expect(manager.getByRole('status')).toContainText('已连接');
    backend.service.shutdownMode = mode;
    backend.service.shutdownDelay = 300;
    try {
      await selectMenu(app, 'NotAlone', '退出 NotAlone');
      await selectMenu(app, 'NotAlone', '退出 NotAlone');
      await expect(manager.getByRole('alert')).toHaveText('后端关闭未获确认，请重试停读。', { timeout: 15_000 });
      expect(appProcess.exitCode).toBeNull();
      expect(await backend.service.observations()).toEqual({ state: 'stopping', shutdownCount: 1, unauthorizedCount: 0 });
      await expect(manager.getByRole('button', { name: '重试连接' })).toHaveCount(0);
      await manager.screenshot({ path: test.info().outputPath(`shutdown-${mode}.png`) });
      backend.service.shutdownMode = 'success';
      await manager.getByRole('button', { name: '重试停读并退出' }).click();
      await expect.poll(() => appProcess.exitCode).toBe(0);
      expect(await backend.service.observations()).toEqual({ state: 'stopped', shutdownCount: 2, unauthorizedCount: 0 });
    } finally { backend.service.shutdownMode = 'success'; }
  });
}

test('成功响应丢失后只有原连接状态确认 stopped 才能退出', async ({ runningApp: { app, appProcess }, backend }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByRole('status')).toContainText('已连接');
  backend.service.shutdownMode = 'lost-response';
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode).toBe(0);
  expect(await backend.service.observations()).toEqual({ state: 'stopped', shutdownCount: 1, unauthorizedCount: 0 });
});

test('停读响应丢失且原连接不可查询时不能以断线声称已停', async ({ runningApp: { app, appProcess }, backend }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByRole('status')).toContainText('已连接');
  backend.service.shutdownMode = 'lost-response';
  backend.service.statusMode = 'failure';
  try {
    await selectMenu(app, 'NotAlone', '退出 NotAlone');
    await expect(manager.getByRole('alert')).toHaveText('后端关闭未获确认，请重试停读。');
    expect(appProcess.exitCode).toBeNull();
    expect((await backend.service.observations()).state).toBe('stopped');
    backend.service.statusMode = 'success';
    await manager.getByRole('button', { name: '重试停读并退出' }).click();
    await expect.poll(() => appProcess.exitCode).toBe(0);
  } finally { backend.service.statusMode = 'success'; }
});

test('退出时握手文件变化仍只关闭原验证运行时，另一实例保持运行', async ({ runningApp: { app, appProcess }, backend }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByRole('status')).toContainText('已连接');
  const replacement = new SyntheticBackend();
  try {
    await replacement.start();
    await replacement.writeHandshake(backend.infoPath);
    await selectMenu(app, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => appProcess.exitCode).toBe(0);
    expect(await backend.service.observations()).toEqual({ state: 'stopped', shutdownCount: 1, unauthorizedCount: 0 });
    expect(await replacement.observations()).toEqual({ state: 'running', shutdownCount: 0, unauthorizedCount: 0 });
  } finally { await replacement.close(); }
});

test('非 App 资源不能使用桥接，也不能接收连接状态', async ({ runningApp: { app } }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByRole('status')).toContainText('已连接');
  const hosted = await app.browserWindow(manager);
  await hosted.evaluate((window) => window.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<html><h1>合成非 App 页面</h1></html>')}`));
  await expect(manager.getByRole('heading', { name: '合成非 App 页面' })).toBeVisible();
  expect(await manager.evaluate(async () => {
    try { await window.notalone.backend.getState(); return false; }
    catch { return true; }
  })).toBe(true);
  await hosted.evaluate((window) => window.webContents.loadURL('notalone://app/index.html#manager'));
  await expect(manager.getByRole('status')).toContainText('已连接');
});

test('运行中断线如实显示失败，重试沿原验证连接恢复', async ({ runningApp: { app }, backend }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByRole('status')).toContainText('已连接');
  backend.service.statusMode = 'failure';
  await expect(manager.getByText('本机服务连接失败，请重试。', { exact: true })).toBeVisible();
  await expect(manager.getByRole('status')).toContainText('尚未连接');
  backend.service.statusMode = 'success';
  await manager.getByRole('button', { name: '重试连接' }).click();
  await expect(manager.getByRole('status')).toContainText('已连接');
});

test('重复 App 启动恢复已有窗口，不创建第二个 App 或后端', async ({ runningApp: { app, appProcess, userData } }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByRole('status')).toContainText('已连接');
  await (await app.browserWindow(manager)).evaluate((window) => window.close());
  const executable = process.env.NOTALONE_TEST_APP_EXECUTABLE || path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  const secondary = await spawnApp(executable, [...(process.env.NOTALONE_TEST_APP_EXECUTABLE ? [] : [path.resolve('.')]), `--user-data-dir=${userData}`], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', NOTALONE_DISABLE_DOTENV: '1',
      NOTALONE_BACKEND_INFO: path.join(userData, 'untrusted-second.info'), NOTALONE_ENV_FILE: path.join(userData, 'synthetic.env'),
      NOTALONE_DATABASE_URL: '', NOTALONE_OWNER_ID: '', DEEPSEEK_API_KEY: '',
      NOTALONE_WECHAT_CLI: path.join(userData, 'unavailable-cli'), NOTALONE_SYNC_PROBE: path.join(userData, 'unavailable-probe') },
    stdio: 'ignore',
  });
  try {
    await expect.poll(() => secondary.exitCode).toBe(0);
    await expect.poll(async () => (await app.browserWindow(manager)).evaluate((window) => window.isVisible())).toBe(true);
    await selectMenu(app, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => appProcess.exitCode).toBe(0);
  } finally {
    if (secondary.exitCode === null) secondary.kill('SIGTERM');
  }
});

test('具名后端桥接拒绝额外参数，渲染层只取得安全连接状态', async ({ runningApp: { app }, backend }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByRole('status')).toContainText('已连接');
  const result = await manager.evaluate(async () => {
    let rejected = false;
    try { await (window.notalone.backend.getState as unknown as (value: string) => Promise<unknown>)('http://example.invalid'); }
    catch { rejected = true; }
    return { rejected, state: await window.notalone.backend.getState(),
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process };
  });
  expect(result.rejected).toBe(true);
  expect(result.require).toBe('undefined');
  expect(result.process).toBe('undefined');
  expect(JSON.stringify(result).includes(backend.service.token)).toBe(false);
  expect(JSON.stringify(result).includes(backend.directory)).toBe(false);
});
