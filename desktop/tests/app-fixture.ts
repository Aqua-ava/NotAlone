import { test as base, _electron as electron, type ElectronApplication } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

type RunningApp = { app: ElectronApplication; appProcess: ChildProcess };

export const test = base.extend<{ runningApp: RunningApp; appDirectory: string }>({
  appDirectory: [path.resolve('.'), { option: true }],
  runningApp: async ({ appDirectory }, use) => {
    const userData = await mkdtemp(path.join(tmpdir(), 'notalone-app-'));
    let app: ElectronApplication | undefined;
    let appProcess: ChildProcess | undefined;
    try {
      app = await electron.launch({
        executablePath: process.env.NOTALONE_TEST_APP_EXECUTABLE,
        args: [...(process.env.NOTALONE_TEST_APP_EXECUTABLE ? [] : [appDirectory]), `--user-data-dir=${userData}`],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      });
      appProcess = app.process();
      await use({ app, appProcess });
    } finally {
      try { if (app && appProcess?.exitCode === null) await app.close(); }
      finally { await rm(userData, { recursive: true, force: true }); }
    }
  },
});

export async function selectMenu(app: ElectronApplication, menu: string, item: string): Promise<void> {
  await app.evaluate(({ Menu }, labels) => {
    const entry = Menu.getApplicationMenu()?.items.find((entry) => entry.label === labels.menu)
      ?.submenu?.items.find((entry) => entry.label === labels.item);
    if (!entry || !entry.enabled) throw new Error('公开菜单操作不可用');
    entry.click();
  }, { menu, item });
}
