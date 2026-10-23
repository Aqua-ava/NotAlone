// 真实源码开发宿主验收：仅合成 PG、独立配置和 renderer 操作；不打包、不调用模型或微信。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { open, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createStorageFixture } from '../../backend-ts/test/host-storage-fixture.mjs';
import { developmentProcesses, requireDevelopmentOnly } from './development-policy.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.dirname(desktop);
const output = process.env.NOTALONE_TEST_OUTPUT || path.join(root, '.scratch/dsh-ts-migration/host-lifecycle/desktop');
const python = process.env.NOTALONE_TEST_PYTHON || path.join(homedir(), 'miniconda3/envs/NotAlone/bin/python');
const npm = process.env.NOTALONE_TEST_NPM_CLI || path.join(path.dirname(path.dirname(python)), 'lib/node_modules/npm/bin/npm-cli.js');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(probe, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
const existing = await developmentProcesses(desktop);
requireDevelopmentOnly(existing);
assert.equal(existing.development.length, 0, '已有开发宿主，保留现场，不能用合成配置替换');
await mkdir(output, { recursive: true });
const fixture = await createStorageFixture();
const originalLedger = (await fixture.client.query('SELECT name, checksum FROM public.notalone_schema_migration ORDER BY name')).rows;
assert.equal(originalLedger.length, 108);
const userData = path.join(fixture.directory, 'desktop');
await mkdir(userData, { recursive: true });
const infoPath = path.join(fixture.directory, 'backend.info');
await writeFile(path.join(userData, 'backend-launch.json'), JSON.stringify({
  pythonExecutable: python, projectDirectory: root, envFilePath: fixture.envFilePath,
  backendInfoPath: infoPath, wechatCliPath: path.join(fixture.directory, 'unavailable-cli'),
  syncProbePath: path.join(fixture.directory, 'unavailable-probe'),
}), { mode: 0o600 });
const environment = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'DISPLAY', 'USER', 'LOGNAME'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
environment.PATH = `${path.dirname(process.execPath)}:${path.dirname(python)}:${environment.PATH || '/usr/bin:/bin'}`;
environment.NOTALONE_DEV_CDP = '1';
let runner, browser, electronPid;
const ownedBackends = new Set();
const results = [];
async function handshake() {
  const text = await readFile(infoPath, 'utf8');
  const data = Object.fromEntries(text.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  const pid = Number(data.pid);
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  ownedBackends.add(pid);
  return data;
}
async function launch() {
  await rm(path.join(userData, 'DevToolsActivePort'), { force: true });
  const log = await open(path.join(fixture.directory, 'dev.log'), 'a', 0o600);
  try { runner = spawn(process.execPath, [npm, 'run', 'dev', '--', '--user-data-dir', userData],
    { cwd: desktop, env: environment, detached: true, stdio: ['ignore', log.fd, log.fd] }); }
  finally { await log.close(); }
  const port = await until(async () => {
    assert.equal(runner.exitCode, null, '开发监督器提前退出');
    const value = await readFile(path.join(userData, 'DevToolsActivePort'), 'utf8').catch(() => '');
    const selected = Number(value.split('\n')[0]);
    return Number.isInteger(selected) && selected > 0 && selected <= 65535 ? selected : undefined;
  }, '开发 CDP 未就绪', 60000);
  const state = await developmentProcesses(desktop, userData);
  requireDevelopmentOnly(state);
  assert.equal(state.development.length, 1);
  electronPid = state.development[0];
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await until(() => browser.contexts().flatMap(context => context.pages()).find(page => page.url() === 'notalone://app/index.html#manager'), '开发页面未就绪');
  await page.waitForFunction(() => window.notalone?.backend && window.notalone?.setup);
  await until(async () => (await page.evaluate(() => window.notalone.backend.getState())).phase === 'connected', '本机后台未连接');
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('button', { name: '设置', exact: true }).click();
  await handshake();
  return page;
}
async function stop() {
  if (electronPid && alive(electronPid)) process.kill(electronPid, 'SIGTERM');
  await until(() => (!electronPid || !alive(electronPid)) && (!runner || runner.exitCode !== null)
    && [...ownedBackends].every(pid => !alive(pid)), '认证退出未完成，保留合成库现场', 25000);
  await browser?.close(); browser = undefined; electronPid = undefined; runner = undefined;
}
let cleaned = false;
try {
  const page = await launch();
  await page.getByLabel('本人展示名称').fill('合成桌面验收本人');
  await page.getByRole('button', { name: '初始化本人', exact: true }).click();
  await until(async () => (await page.evaluate(() => window.notalone.setup.getState())).phase === 'ready', '本人初始化后未恢复');
  await handshake();
  const firstOwners = (await fixture.client.query('SELECT id FROM public.owner')).rows;
  assert.equal(firstOwners.length, 1);
  results.push('首次初始化本人并认证重启');
  await page.getByLabel('DeepSeek API Key').fill('synthetic_dsh_desktop_unused_key');
  await page.getByRole('button', { name: '保存 DeepSeek 密钥', exact: true }).click();
  await until(async () => { const state = await page.evaluate(() => window.notalone.setup.getState()); return state.phase === 'ready' && state.credentialsConfigured; }, '凭据保存后未恢复');
  const beforeCrash = await handshake();
  results.push('合成凭据保存并认证重启，未调用模型');
  await page.screenshot({ path: path.join(output, 'configured.png') });
  process.kill(Number(beforeCrash.pid), 'SIGKILL');
  await page.getByRole('button', { name: '重试连接', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'crashed.png') });
  await page.getByRole('button', { name: '重试连接', exact: true }).click();
  await until(async () => (await page.evaluate(() => window.notalone.backend.getState())).phase === 'connected', '异常后明确重试未连接');
  assert.notEqual((await handshake()).pid, beforeCrash.pid);
  results.push('真实后台异常退出可见，手动重试恢复新代际');
  await stop();
  const reopened = await launch();
  await until(async () => { const state = await reopened.evaluate(() => window.notalone.setup.getState()); return state.phase === 'ready' && state.credentialsConfigured; }, '重新启动未恢复既有本人');
  assert.equal(await reopened.getByLabel('本人展示名称').count(), 0);
  await reopened.screenshot({ path: path.join(output, 'restored.png') });
  assert.deepEqual((await fixture.client.query('SELECT id FROM public.owner')).rows, firstOwners);
  assert.deepEqual((await fixture.client.query('SELECT name, checksum FROM public.notalone_schema_migration ORDER BY name')).rows, originalLedger);
  results.push('重新启动恢复既有本人及凭据，无重复初始化，107条迁移及checksum保持');
  await stop();
  // 只删除本轮合成配置的 owner 引用，原库和既有身份保持，要求用户明确恢复。
  const configured = await readFile(fixture.envFilePath, 'utf8');
  await writeFile(fixture.envFilePath, configured.split('\n').filter(line => !line.startsWith('NOTALONE_OWNER_ID=')).join('\n'), { mode: 0o600 });
  const recovery = await launch();
  await recovery.getByRole('button', { name: '恢复已有本人配置', exact: true }).waitFor();
  assert.deepEqual((await fixture.client.query('SELECT id FROM public.owner')).rows, firstOwners);
  await recovery.getByRole('button', { name: '恢复已有本人配置', exact: true }).click();
  await until(async () => (await recovery.evaluate(() => window.notalone.setup.getState())).phase === 'ready', '明确恢复已有本人未完成');
  await handshake();
  assert.deepEqual((await fixture.client.query('SELECT id FROM public.owner')).rows, firstOwners);
  await recovery.screenshot({ path: path.join(output, 'recovered-owner.png') });
  results.push('唯一已有本人缺少配置时明确确认恢复，原身份不变');
  await stop();
  await fixture.close(); cleaned = true;
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: results, cleanup: true, mode: 'npm run dev', computerUse: 'unavailable', renderer: 'Playwright CDP', modelCalls: 0, wechatReads: 0 }, null, 2));
  console.log(JSON.stringify({ passed: results.length, cleanup: true }));
} finally {
  if (!cleaned) {
    await stop();
    await fixture.close();
  }
}
