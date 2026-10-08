import { test as base, type ElectronApplication } from '@playwright/test';
import { launchApp, verifyAppTestLease } from './app-test-gate';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

type RunningApp = { app: ElectronApplication; appProcess: ChildProcess; userData: string };
type AppOptions = { appEnvironment: NodeJS.ProcessEnv; launchConfiguration: object | undefined; appWorkingDirectory: string | undefined };

export function isolatedAppEnvironment(userData: string, overrides: NodeJS.ProcessEnv = {}): Record<string, string> {
  const environment = {
    ...process.env, ELECTRON_RUN_AS_NODE: '',
    NOTALONE_DISABLE_DOTENV: '1', NOTALONE_ENV_FILE: path.join(userData, 'synthetic.env'),
    NOTALONE_BACKEND_INFO: path.join(userData, 'backend.info'),
    NOTALONE_DATABASE_URL: '', NOTALONE_OWNER_ID: '', DEEPSEEK_API_KEY: '',
    NOTALONE_WECHAT_CLI: path.join(userData, 'unavailable-cli'),
    NOTALONE_SYNC_PROBE: path.join(userData, 'unavailable-probe'),
    ...overrides,
  };
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

export const test = base.extend<AppOptions & { runningApp: RunningApp; appDirectory: string }>({
  appDirectory: [path.resolve('.'), { option: true }],
  appEnvironment: [{}, { option: true }],
  launchConfiguration: [undefined, { option: true }],
  appWorkingDirectory: [undefined, { option: true }],
  runningApp: async ({ appDirectory, appEnvironment, launchConfiguration, appWorkingDirectory }, use) => {
    await verifyAppTestLease();
    const userData = await mkdtemp(path.join(tmpdir(), 'notalone-app-'));
    let app: ElectronApplication | undefined;
    let appProcess: ChildProcess | undefined;
    try {
      if (launchConfiguration) await writeFile(path.join(userData, 'backend-launch.json'), JSON.stringify(launchConfiguration));
      app = await launchApp({
        cwd: appWorkingDirectory,
        executablePath: process.env.NOTALONE_TEST_APP_EXECUTABLE,
        args: [...(process.env.NOTALONE_TEST_APP_EXECUTABLE ? [] : [appDirectory]), `--user-data-dir=${userData}`],
        env: isolatedAppEnvironment(userData, appEnvironment),
      });
      appProcess = app.process();
      await use({ app, appProcess, userData });
    } finally {
      // 故障断言失败时也只回收本轮测试 App，不把强制回收算作产品退出验收。
      const fallback = setTimeout(() => { if (appProcess?.exitCode === null && appProcess.signalCode === null) appProcess.kill('SIGKILL'); }, 5000);
      try { if (app && appProcess?.exitCode === null && appProcess.signalCode === null) await app.close().catch(() => {}); }
      finally {
        clearTimeout(fallback);
        await rm(userData, { recursive: true, force: true });
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
