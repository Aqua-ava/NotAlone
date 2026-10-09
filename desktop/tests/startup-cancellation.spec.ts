import { expect } from '@playwright/test';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { selectMenu } from './app-fixture';
import { projectDirectory, pythonExecutable, test as startupTest } from './startup-fixture';

const test = startupTest.extend({
  databaseState: 'ready',
  launchConfiguration: async ({ startupDatabase }, use) => {
    const wrapper = path.join(startupDatabase.directory, 'controlled-python');
    const marker = path.join(startupDatabase.directory, 'diagnostic.pid');
    const release = path.join(startupDatabase.directory, 'diagnostic.release');
    // 仅在操作系统子进程边界延迟真实诊断；释放后仍执行当前项目的公开入口。
    await writeFile(wrapper, `#!${pythonExecutable}\nimport os, signal, sys, time\nfrom pathlib import Path\nif sys.argv[1:3] == ['-m', 'notalone.startup_diagnostics']:\n    Path(${JSON.stringify(marker)}).write_text(str(os.getpid()))\n    signal.signal(signal.SIGTERM, signal.SIG_IGN)\n    while not Path(${JSON.stringify(release)}).exists(): time.sleep(0.01)\nos.execv(${JSON.stringify(pythonExecutable)}, [${JSON.stringify(pythonExecutable)}, *sys.argv[1:]])\n`);
    await chmod(wrapper, 0o700);
    await use({ pythonExecutable: wrapper, projectDirectory });
  },
});

test('检查中退出有界回收本轮诊断子进程，迟到诊断不能启动后端', async ({ runningApp: { app, appProcess, userData }, startupDatabase }) => {
  const manager = await app.firstWindow();
  const marker = path.join(startupDatabase.directory, 'diagnostic.pid');
  let pid: number | undefined;
  try {
    await expect.poll(async () => readFile(marker, 'utf8').then((value) => Number(value), () => 0)).toBeGreaterThan(0);
    pid = Number(await readFile(marker, 'utf8'));
    await expect(manager.getByText('正在只读检查机器环境…', { exact: true })).toBeVisible();
    await manager.getByRole('button', { name: '应用配置', exact: true }).click();
    await expect(manager.getByLabel('后端握手文件', { exact: true })).toBeDisabled();
    const configuration = await readFile(path.join(userData, 'backend-launch.json'));
    expect(await manager.evaluate(async () => {
      const paths = await window.notalone.startup.getPaths();
      try { await window.notalone.startup.savePaths({ ...paths, backendInfoPath: `${paths.backendInfoPath}.replacement` }); return false; }
      catch { return true; }
    })).toBe(true);
    expect((await readFile(path.join(userData, 'backend-launch.json'))).equals(configuration)).toBe(true);
    await selectMenu(app, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => appProcess.exitCode).toBe(0);
    await expect.poll(() => { try { process.kill(pid!, 0); return true; } catch { return false; } }).toBe(false);
    await writeFile(path.join(startupDatabase.directory, 'diagnostic.release'), 'synthetic release');
    expect(await readFile(path.join(userData, 'backend.info'), 'utf8').then(() => true, () => false)).toBe(false);
  } finally {
    // 只回收由本用例受控 wrapper 自报的诊断 PID，不使用后端握手 PID。
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
});

test('只读诊断超时后明确重试可恢复，旧诊断结果不能覆盖新连接', async ({ runningApp: { app, userData }, startupDatabase }) => {
  const manager = await app.firstWindow();
  const marker = path.join(startupDatabase.directory, 'diagnostic.pid');
  let pid: number | undefined;
  try {
    await expect.poll(async () => readFile(marker, 'utf8').then((value) => Number(value), () => 0)).toBeGreaterThan(0);
    pid = Number(await readFile(marker, 'utf8'));
    await manager.getByRole('button', { name: '应用配置', exact: true }).click();
    await expect(manager.getByText('机器环境检查超时。', { exact: true })).toBeVisible({ timeout: 15_000 });
    expect(await readFile(path.join(userData, 'backend.info'), 'utf8').then(() => true, () => false)).toBe(false);
    await expect.poll(() => { try { process.kill(pid!, 0); return true; } catch { return false; } }).toBe(false);
    await manager.getByLabel('Python 可执行文件', { exact: true }).fill(pythonExecutable);
    await manager.getByRole('button', { name: '保存启动路径', exact: true }).click();
    await expect(manager.getByText('启动路径已保存。请重新检查并连接。', { exact: true })).toBeVisible();
    await manager.getByRole('button', { name: '重新检查并连接', exact: true }).click();
    await expect(manager.getByText('已连接', { exact: true })).toBeVisible({ timeout: 15_000 });
    await writeFile(path.join(startupDatabase.directory, 'diagnostic.release'), 'synthetic late release');
    await expect(manager.getByText('机器环境已就绪。', { exact: true })).toBeVisible();
  } finally { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
});
