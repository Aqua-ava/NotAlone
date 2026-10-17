import { test as base, type ElectronApplication } from '@playwright/test';
import { launchApp, verifyAppTestLease } from './app-test-gate';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

type RunningApp = { app: ElectronApplication; appProcess: ChildProcess; userData: string };
type AppOptions = { appEnvironment: NodeJS.ProcessEnv; launchConfiguration: object | undefined; appWorkingDirectory: string | undefined; retainUserData: boolean;
  appExecutable: string | undefined; appDataPreparation: (directory: string) => Promise<void> };

import { isolatedAppEnvironment } from './isolated-environment';
export { isolatedAppEnvironment } from './isolated-environment';

export const test = base.extend<AppOptions & { runningApp: RunningApp; appDirectory: string }>({
  appDirectory: [path.resolve('.'), { option: true }],
  appEnvironment: [{}, { option: true }],
  launchConfiguration: [undefined, { option: true }],
  appWorkingDirectory: [undefined, { option: true }],
  retainUserData: [false, { option: true }],
  appExecutable: [process.env.NOTALONE_TEST_APP_EXECUTABLE, { option: true }],
  appDataPreparation: [async ({}, use) => { await use(async () => {}); }, { option: true }],
  runningApp: async ({ appDirectory, appExecutable, appEnvironment, launchConfiguration, appWorkingDirectory, appDataPreparation, retainUserData }, use) => {
    await verifyAppTestLease();
    const userData = await mkdtemp(path.join(tmpdir(), 'notalone-app-'));
    let app: ElectronApplication | undefined;
    let appProcess: ChildProcess | undefined;
    try {
      if (launchConfiguration) await writeFile(path.join(userData, 'backend-launch.json'), JSON.stringify(launchConfiguration));
      await appDataPreparation(userData);
      app = await launchApp({
        cwd: appWorkingDirectory,
        executablePath: appExecutable,
        args: [...(appExecutable ? [] : [appDirectory]), `--user-data-dir=${userData}`],
        env: isolatedAppEnvironment(userData, appEnvironment),
      });
      appProcess = app.process();
      // 在场景断言前记录自有实例，失败时仍可按精确PID／目录核验收尾。
      await writeFile(base.info().outputPath('app-test-owned.json'), JSON.stringify({
        pid: appProcess.pid, userData, executable: appExecutable ?? null,
      }), { mode: 0o600, flag: 'wx' });
      await use({ app, appProcess, userData });
    } finally {
      // 故障断言失败时也只回收本轮测试 App，不把强制回收算作产品退出验收。
      const fallback = setTimeout(() => { if (appProcess?.exitCode === null && appProcess.signalCode === null) appProcess.kill('SIGKILL'); }, 5000);
      try { if (app && appProcess?.exitCode === null && appProcess.signalCode === null) await app.close().catch(() => {}); }
      finally {
        clearTimeout(fallback);
        if (retainUserData) {
          // 选中的实际验收先保留现场；证据封存后由协调者只清理本轮精确目录。
          await writeFile(base.info().outputPath('app-user-data-retained.json'), JSON.stringify({
            userData, pid: appProcess?.pid ?? null, exitCode: appProcess?.exitCode ?? null,
            signal: appProcess?.signalCode ?? null, retained: true,
          }), { mode: 0o600, flag: 'wx' });
        } else await rm(userData, { recursive: true, force: true });
      }
    }
  },
});

export async function selectMenu(app: ElectronApplication, menu: string, item: string): Promise<void> {
  await app.evaluate(({ Menu }, labels) => {
    const entry = Menu.getApplicationMenu()?.items.find((entry) => entry.label === labels.menu)
      ?.submenu?.items.find((entry) => entry.label === labels.item);
    if (!entry || !entry.enabled) throw new Error('公开菜单操作不可用');
    // macOS 的 hide role 由 Cocoa 执行，MenuItem.click 不会路由该默认动作。
    if (entry.role === 'hide') Menu.sendActionToFirstResponder('hide:');
    else entry.click();
  }, { menu, item });
}
