import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Browser } from '@playwright/test';
import { ContactFixture, type ContactDatabase } from '../contact-backend-fixture';
import { ContactHttpProxy } from '../contact-http-proxy';
import { isolatedAppEnvironment } from '../isolated-environment';
import { savedImport, changedImport, failedImportRecovery, priorityImport, staleImportViewing,
  staleImportContact, staleImportConnection, lostImportResponse, firstImportBootstrap,
  type ImportStalePages } from '../import-page-scenarios';
import { PageHost } from './page-host';
import { withControllerEnvironment, withImportBackend } from './backend-fixture';
import { ownResource } from './cleanup';

// 每项独立真实库和页面上下文；只有系统文件选择由本轮 Node 宿主提供。
async function withImportPages(browser: Browser, origin: string, use: (pages: ImportStalePages) => Promise<void>) {
  await withImportBackend(async (importBackend) => {
    const importProxy = await ContactHttpProxy.attach(importBackend.infoPath, '/api/imports/commit');
    const proxyReleased = ownResource();
    try { await withControllerEnvironment(importBackend, async (userData) => {
      let selectedFile: string | undefined;
      const host = new PageHost(await browser.newContext(), origin, userData, {
        chooseImportFile: async () => selectedFile ? { canceled: false, filePaths: [selectedFile] } : { canceled: true, filePaths: [] },
      });
      try {
        await host.backend.connect();
        const manager = await host.open('manager');
        const helper = await host.open('helper');
        await use({ manager, helper, importBackend, importProxy,
          chooseFile: async (filePath) => { selectedFile = filePath; },
          screenshotPath: 'artifacts/headless-pages/import-task-completed.png' });
      } finally { importProxy.release(); await host.close(); }
    }); } finally { await importProxy.close(); proxyReleased(); }
  });
}
async function runImportScenarios(browser: Browser, origin: string,
  scenarios: Array<[string, (pages: ImportStalePages) => Promise<void>]>) {
  for (const [name, scenario] of scenarios) {
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withImportPages(browser, origin, scenario);
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}
export async function importSubmitAcceptance(browser: Browser, origin: string) {
  await runImportScenarios(browser, origin, [
    ['保存真实消息来源五步骤与原任务重复导入', savedImport],
    ['文件改变拒绝与重新确认', changedImport],
    ['真实提取失败与原任务恢复', failedImportRecovery],
    ['多批提取期间前台回复优先', priorityImport],
  ]);
}
export async function importStaleAcceptance(browser: Browser, origin: string) {
  const scenarios: Array<[string, (pages: ImportStalePages) => Promise<void>]> = [];
  for (const failure of [false, true]) {
    const outcome = failure ? '失败' : '成功';
    scenarios.push([`停止查看后迟到${outcome}`, (pages) => staleImportViewing(pages, failure)],
      [`另一角色页面换联系人后迟到${outcome}`, (pages) => staleImportContact(pages, failure)],
      [`真实换连接后迟到${outcome}`, (pages) => staleImportConnection(pages, failure)]);
  }
  scenarios.push(['保存响应丢失后重新确认恢复原来源', lostImportResponse]);
  await runImportScenarios(browser, origin, scenarios);
}

// 首份场景由生产 BackendHost 启动及重启真实后端；停读未确认时保留库和归属记录。
export async function importBootstrap(browser: Browser, origin: string) {
  if (process.env.CONDA_DEFAULT_ENV !== 'NotAlone' || !process.env.CONDA_PREFIX) throw new Error('首份导入验收须先激活 Conda NotAlone。');
  const name = '首份导入后认证停读重装配，不新增读取授权';
  process.stdout.write(`page_test_scenario: ${name}\n`);
  const released = ownResource();
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-headless-import-bootstrap-'));
  const python = path.join(process.env.CONDA_PREFIX, 'bin/python');
  const execute = promisify(execFile);
  const script = path.resolve('tests/fixtures/contact-database.py');
  const environment = isolatedAppEnvironment(directory, {
    PYTHONPATH: path.resolve('../backend/src'), NOTALONE_DEEPSEEK_API_KEY: '', NOTALONE_DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
  });
  let data: ContactDatabase | undefined;
  let stopped = true;
  let failure: unknown;
  try {
    const prepared = await execute(python, [script, 'create', 'empty'], { env: environment, timeout: 70_000 });
    data = JSON.parse(prepared.stdout) as ContactDatabase;
    const fixture = new ContactFixture(directory, python, data);
    await withControllerEnvironment(fixture, async (userData) => {
      let selectedFile: string | undefined;
      const host = new PageHost(await browser.newContext(), origin, userData, {
        chooseImportFile: async () => selectedFile ? { canceled: false, filePaths: [selectedFile] } : { canceled: true, filePaths: [] },
      });
      stopped = false;
      try {
        await host.backend.connect();
        await firstImportBootstrap(await host.open('manager'), fixture, async (filePath) => { selectedFile = filePath; });
      } finally { await host.close(); stopped = true; }
    });
  } catch (error) { failure = error; }
  try {
    if (!stopped) throw new Error('首份导入后端停读未确认。');
    if (data) {
      await execute(python, [script, 'drop', data.database_name], { env: environment, timeout: 15_000 });
      // 精确核验本轮库不存在，不把drop命令完成当作清理证明。
      await execute(python, ['-c', 'import sys, psycopg\nwith psycopg.connect("host=/tmp dbname=postgres") as c:\n n = c.execute("SELECT count(*) FROM pg_database WHERE datname = %s", (sys.argv[1],)).fetchone()[0]\n if n: raise RuntimeError("本轮首份导入库仍存在。")', data.database_name],
        { env: environment, timeout: 15_000 });
    }
    await rm(directory, { recursive: true, force: true });
    released();
  } catch {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'cleanup-unconfirmed.json'), JSON.stringify({ databaseName: data?.database_name ?? null, stopped }), { mode: 0o600 });
    throw new Error(`首份导入收尾未确认，保留归属记录：${directory}`);
  }
  if (failure) throw failure;
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}
