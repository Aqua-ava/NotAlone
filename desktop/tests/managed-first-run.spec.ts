import { expect } from '@playwright/test';
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test as appTest, selectMenu, isolatedAppEnvironment } from './app-fixture';
import { launchApp } from './app-test-gate';

const test = appTest.extend<{ managedPackage: { original: string; moved: string } }>({
  managedPackage: async ({}, use) => {
    const executable = process.env.NOTALONE_TEST_APP_EXECUTABLE;
    if (!executable || !executable.endsWith('.app/Contents/MacOS/NotAlone')) throw new Error('本用例需要明确的实际 App 包');
    const directory = await mkdtemp(path.join(tmpdir(), 'notalone-managed-package-'));
    const original = path.join(directory, 'original/NotAlone.app');
    const moved = path.join(directory, '搬动后的 App/NotAlone.app');
    try {
      await cp(path.dirname(path.dirname(path.dirname(executable))), original, { recursive: true, verbatimSymlinks: true });
      await mkdir(path.dirname(moved));
      await use({ original, moved });
    } finally { await rm(directory, { recursive: true, force: true }); }
  },
  appExecutable: async ({ managedPackage }, use) => { await use(path.join(managedPackage.original, 'Contents/MacOS/NotAlone')); },
  appWorkingDirectory: '/',
});

// 实际约1GB包的复制和启动也计入夹具预算；不改变产品内的启动/停止时限。
test.setTimeout(120_000);

function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

test('App 主进程意外退出后受管后台先停读、资料服务退场，同资料目录重开保留本人', async ({ runningApp: { app, appProcess, userData }, managedPackage }) => {
  test.setTimeout(120_000);
  const manager = await app.firstWindow();
  await manager.evaluate(() => {
    const target = window as typeof window & { managedTrace?: object[] };
    target.managedTrace = [];
    window.notalone.backend.onStateChanged(state => target.managedTrace!.push({ at: Date.now(), kind: 'backend', phase: state.phase, code: state.errorCode }));
    window.notalone.startup.onStateChanged(state => target.managedTrace!.push({ at: Date.now(), kind: 'startup', phase: state.phase, code: state.code }));
  });
  await manager.getByRole('button', { name: '开始本机设置', exact: true }).click();
  try { await expect(manager.getByText('已连接', { exact: true })).toBeVisible({ timeout: 60_000 }); }
  finally { await writeFile(test.info().outputPath('startup-phases.json'), JSON.stringify(await manager.evaluate(() => (window as typeof window & { managedTrace?: object[] }).managedTrace)), { mode: 0o600 }); }
  await manager.getByLabel('本人展示名称', { exact: true }).fill('合成崩溃恢复使用者');
  await manager.getByRole('button', { name: '初始化本人', exact: true }).click();
  try { await expect(manager.getByText('本次运行的本人身份已就绪', { exact: true })).toBeVisible({ timeout: 30_000 }); }
  finally { await writeFile(test.info().outputPath('startup-phases.json'), JSON.stringify(await manager.evaluate(() => (window as typeof window & { managedTrace?: object[] }).managedTrace)), { mode: 0o600 }); }
  const databasePid = Number((await readFile(path.join(userData, 'managed/postgres/postmaster.pid'), 'utf8')).split('\n')[0]);
  const backendPid = Number(/^pid=(\d+)$/m.exec(await readFile(path.join(userData, 'managed/backend.info'), 'utf8'))?.[1]);
  const databaseParentPid = Number(execFileSync('/bin/ps', ['-p', String(databasePid), '-o', 'ppid='], { encoding: 'utf8' }).trim());
  expect(Number.isSafeInteger(backendPid) && backendPid > 1).toBe(true);
  expect(Number.isSafeInteger(databaseParentPid) && databaseParentPid > 1).toBe(true);
  await writeFile(test.info().outputPath('crash-owned.json'), JSON.stringify({ appPid: appProcess.pid, databasePid, databaseParentPid, backendPid, userData }), { mode: 0o600 });
  let reopened: Awaited<ReturnType<typeof launchApp>> | undefined;
  let reopenedProcess: import('node:child_process').ChildProcess | undefined;
  try {
    appProcess.kill('SIGKILL');
    await expect.poll(() => processAlive(backendPid), { timeout: 15_000, message: 'Main 死亡后本次后台必须先停止' }).toBe(false);
    await expect.poll(() => processAlive(databasePid), { timeout: 15_000, message: 'Main 死亡后本次 PostgreSQL 必须退场' }).toBe(false);
    await expect.poll(() => processAlive(databaseParentPid), { timeout: 5000 }).toBe(false);
    expect(await access(path.join(userData, 'managed/backend.info')).then(() => true, () => false)).toBe(false);
    expect(await access(path.join(userData, 'managed/postgres/postmaster.pid')).then(() => true, () => false)).toBe(false);
    reopened = await launchApp({ executablePath: path.join(managedPackage.original, 'Contents/MacOS/NotAlone'), cwd: '/',
      args: [`--user-data-dir=${userData}`], env: isolatedAppEnvironment(userData) });
    reopenedProcess = reopened.process();
    const reopenedManager = await reopened.firstWindow();
    await expect(reopenedManager.getByText('已连接', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(reopenedManager.getByText('本次运行的本人身份已就绪', { exact: true })).toBeVisible();
    await expect(reopenedManager.getByRole('heading', { name: '还没有联系人', exact: true })).toBeVisible();
    await selectMenu(reopened, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => reopenedProcess?.exitCode, { timeout: 15_000 }).toBe(0);
  } finally {
    if (reopened && reopenedProcess?.exitCode === null) await reopened.close().catch(() => {});
    // 断言失败的清理仅针对本例启动完成后精确记录的自有子进程。
    if (processAlive(backendPid)) process.kill(backendPid, 'SIGTERM');
    await expect.poll(() => processAlive(backendPid), { timeout: 7000 }).toBe(false);
    if (processAlive(databasePid)) process.kill(databasePid, 'SIGINT');
    await expect.poll(() => processAlive(databasePid), { timeout: 10_000 }).toBe(false);
  }
});

test('独立新安装由公开首启操作准备本机服务，确认本人后进入真实空联系人，搬动重开保留设置', async ({ runningApp: { app, appProcess, userData }, managedPackage }) => {
  test.setTimeout(120_000);
  const manager = await app.firstWindow();
  await expect(manager.getByRole('heading', { name: '欢迎使用 NotAlone', exact: true })).toBeVisible();
  await expect(manager.getByLabel('Python 可执行文件', { exact: true })).toHaveCount(0);
  expect(await access(path.join(userData, 'backend-launch.json')).then(() => true, () => false)).toBe(false);
  await manager.getByRole('button', { name: '开始本机设置', exact: true }).click();
  await expect(manager.getByText('已连接', { exact: true })).toBeVisible({ timeout: 60_000 });
  const setup = manager.getByRole('region', { name: '本人身份与模型' });
  await expect(setup.getByText('本人身份尚未初始化', { exact: true })).toBeVisible();
  await setup.getByLabel('本人展示名称', { exact: true }).fill('合成首启使用者');
  await setup.getByRole('button', { name: '初始化本人', exact: true }).click();
  await expect(setup.getByText('本次运行的本人身份已就绪', { exact: true })).toBeVisible({ timeout: 30_000 });
  // 仅验证密钥保存语义，不调用外部模型或冒充真实模型验收。
  await setup.getByLabel('DeepSeek API Key', { exact: true }).fill('synthetic-first-run-not-a-real-key');
  await setup.getByRole('button', { name: '保存 DeepSeek 密钥', exact: true }).click();
  await expect(setup.getByText('DeepSeek 已配置', { exact: true })).toBeVisible({ timeout: 30_000 });
  await manager.getByRole('button', { name: '联系人与绑定', exact: true }).click();
  await expect(manager.getByText('已连接', { exact: true })).toBeVisible();
  await expect(manager.getByRole('heading', { name: '还没有联系人', exact: true })).toBeVisible();
  expect((await stat(path.join(userData, 'managed/runtime.env'))).mode & 0o077).toBe(0);
  const databasePid = Number((await readFile(path.join(userData, 'managed/postgres/postmaster.pid'), 'utf8')).split('\n')[0]);
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode, { timeout: 15_000 }).toBe(0);
  expect(await access(path.join(userData, 'managed/backend.info')).then(() => true, () => false)).toBe(false);
  await expect.poll(() => processAlive(databasePid)).toBe(false);
  await rename(managedPackage.original, managedPackage.moved);
  const reopened = await launchApp({ executablePath: path.join(managedPackage.moved, 'Contents/MacOS/NotAlone'), cwd: '/',
    args: [`--user-data-dir=${userData}`], env: isolatedAppEnvironment(userData) });
  const reopenedProcess = reopened.process();
  await writeFile(test.info().outputPath('reopened-app-owned.json'), JSON.stringify({ pid: reopenedProcess.pid, userData }), { mode: 0o600 });
  try {
    const reopenedManager = await reopened.firstWindow();
    await expect(reopenedManager.getByText('已连接', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(reopenedManager.getByText('本次运行的本人身份已就绪', { exact: true })).toBeVisible();
    await expect(reopenedManager.getByText('DeepSeek 已配置', { exact: true })).toBeVisible();
    await expect(reopenedManager.getByRole('heading', { name: '还没有联系人', exact: true })).toBeVisible();
    await expect(reopenedManager.getByRole('button', { name: '开始本机设置', exact: true })).toHaveCount(0);
    await selectMenu(reopened, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => reopenedProcess.exitCode, { timeout: 15_000 }).toBe(0);
  } finally { if (reopenedProcess.exitCode === null) await reopened.close().catch(() => {}); }
});

test('取消首启等待真实停止后可继续，不会把取消显示为已连接', async ({ runningApp: { app, appProcess, userData } }) => {
  test.setTimeout(90_000);
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '开始本机设置', exact: true }).click();
  await manager.getByRole('button', { name: '取消本次设置', exact: true }).click();
  await expect(manager.getByText('本次设置已取消。', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(manager.getByText('已连接', { exact: true })).toHaveCount(0);
  expect(await access(path.join(userData, 'managed/backend.info')).then(() => true, () => false)).toBe(false);
  await manager.getByRole('button', { name: '继续本机设置', exact: true }).click();
  await expect(manager.getByText('已连接', { exact: true })).toBeVisible({ timeout: 60_000 });
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode, { timeout: 15_000 }).toBe(0);
});

test('包内运行组件缺损给出真实恢复动作，恢复原组件后可从公开入口继续', async ({ runningApp: { app, appProcess, userData }, managedPackage }) => {
  test.setTimeout(90_000);
  const manager = await app.firstWindow();
  const python = path.join(managedPackage.original, 'Contents/Resources/notalone-runtime/python/bin/python3.12');
  const original = await readFile(python);
  await rm(python);
  await manager.getByRole('button', { name: '开始本机设置', exact: true }).click();
  await expect(manager.getByText('App 运行组件缺失或校验未通过。', { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(await access(path.join(userData, 'managed/state.json')).then(() => true, () => false)).toBe(false);
  await manager.getByRole('button', { name: '停止并返回', exact: true }).click();
  await expect(manager.getByText('本次设置已取消。', { exact: true })).toBeVisible();
  await writeFile(python, original, { mode: 0o755 });
  await manager.getByRole('button', { name: '继续本机设置', exact: true }).click();
  await expect(manager.getByText('已连接', { exact: true })).toBeVisible({ timeout: 60_000 });
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode, { timeout: 15_000 }).toBe(0);
});
