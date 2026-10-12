import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { requestAppTestLease } from '../scripts/app-test-lease.mjs';
import { verifyAppTestLease } from './app-test-gate';
import { createFinderUserData } from './finder-user-data';
import { prepareDatabase, projectDirectory, pythonExecutable } from './startup-fixture';
import { readConnection } from '../src/main/backend/connection';

test.skip(process.env.NOTALONE_FINDER_PACKAGE_ACCEPTANCE !== '1', '仅主Agent在有限时段用Finder打开最终包');
const execute = promisify(execFile);

async function appProcesses(executable?: string) {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,uid=,comm=', '-ww']);
  return stdout.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line))
    .filter((match) => match && Number(match[2]) === process.getuid?.()
      && (executable ? match[3] === executable : /\/NotAlone(?:App)?\.app\/Contents\/MacOS\/NotAlone(?:App)?$/.test(match[3])))
    .map((match) => Number(match![1]));
}

function pidAlive(pid: number): boolean {
  // signal 0只查询本轮记录的PID；只有明确ESRCH能证明已退出，其他错误保留现场。
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

async function coordinatorReceipt(filePath: string) {
  let file;
  try { file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096 || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('finder_receipt_unsafe');
    return JSON.parse(await file.readFile('utf8')) as Record<string, unknown>;
  } finally { await file.close(); }
}

test('最终签名包由Finder打开，绝对解释器连接隔离PG、双窗口可用并正常退出恢复原配置', async () => {
  test.setTimeout(8 * 60_000);
  await verifyAppTestLease();
  const executable = await realpath(process.env.NOTALONE_TEST_APP_EXECUTABLE || '/unconfigured');
  expect(executable.endsWith('/NotAlone.app/Contents/MacOS/NotAlone')).toBe(true);
  const appBundlePath = path.dirname(path.dirname(path.dirname(executable)));
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', appBundlePath]);
  expect(await appProcesses()).toEqual([]);
  const directory = path.join(homedir(), 'Library/Application Support/NotAloneDesktop');
  expect(await lstat(path.join(directory, 'SingletonLock')).then(() => true,
    (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
  const database = await prepareDatabase('create');
  const owned = await mkdtemp(path.join(path.dirname(directory), '.notalone-finder-'));
  const coordinationPath = test.info().outputPath('finder-coordination.json');
  const receiptPath = test.info().outputPath('finder-coordinator-receipt.json');
  const infoPath = path.join(owned, 'backend.info');
  let isolation: Awaited<ReturnType<typeof createFinderUserData>> | undefined;
  let launchId: string | undefined;
  let backendPid: number | undefined;
  let complete = false;
  const writeCoordination = async (phase: string, extra = {}) => writeFile(coordinationPath, JSON.stringify({
    phase, appBundlePath, executable, directory, ownedDirectory: owned,
    databaseName: database.database, infoPath, receiptPath, originalIdentity: isolation?.originalIdentity ?? null, ...extra,
  }), { mode: 0o600 });
  try {
    await prepareDatabase('migrate', database.database);
    const permit = await requestAppTestLease('launch');
    launchId = permit.launchId;
    isolation = await createFinderUserData(directory, owned);
    const envFilePath = path.join(owned, 'synthetic.env');
    await writeFile(envFilePath, [
      `NOTALONE_DATABASE_URL=host=/tmp port=${process.env.PGPORT || '5432'} dbname=${database.database}`,
      'LANGSMITH_TRACING=false', 'LANGCHAIN_TRACING_V2=false', 'LANGCHAIN_TRACING=false',
      'NOTALONE_DEEPSEEK_API_KEY=', 'NOTALONE_DEEPSEEK_BASE_URL=http://127.0.0.1:1',
    ].join('\n') + '\n', { mode: 0o600 });
    await writeFile(path.join(directory, 'backend-launch.json'), JSON.stringify({
      pythonExecutable, projectDirectory, envFilePath, backendInfoPath: infoPath,
      wechatCliPath: path.join(owned, 'unavailable-cli'), syncProbePath: path.join(owned, 'unavailable-probe'),
    }), { mode: 0o600 });
    await verifyAppTestLease();
    await writeCoordination('waiting_for_finder', { until: permit.until, ownedIdentity: isolation.ownedIdentity });
    console.log(`Finder协调记录：${coordinationPath}`);
    await expect.poll(() => appProcesses(executable), { timeout: 3 * 60_000 }).toHaveLength(1);
    const appPid = (await appProcesses(executable))[0];
    await expect.poll(() => readConnection(infoPath), { timeout: 60_000 }).not.toBeUndefined();
    const connection = (await readConnection(infoPath))!;
    backendPid = connection.pid;
    const response = await fetch(`http://${connection.address}/api/runtime/status`, {
      headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'running' });
    await writeCoordination('backend_ready', { appPid, backendPid, until: permit.until, ownedIdentity: isolation.ownedIdentity });
    await expect.poll(() => coordinatorReceipt(receiptPath), { timeout: 3 * 60_000 }).toEqual({
      finderOpened: true, managerReady: true, configurationReady: true,
      helperOpened: true, helperHidden: true, normalQuitRequested: true,
    });
    await expect.poll(() => appProcesses(executable), { timeout: 15_000 }).toEqual([]);
    await expect.poll(() => pidAlive(backendPid!)).toBe(false);
    expect(await readConnection(infoPath)).toBeUndefined();
    complete = true;
  } finally {
    // Finder启动不属于runner的子进程；未确认App/后端退场就保留租约、原备份与测试库。
    // 已放行Finder但还未取得自有后端PID时，缺握手不能证明后端没有启动。
    const backendAlive = backendPid ? pidAlive(backendPid) : Boolean(launchId);
    const unfinishedBackup = !isolation && await lstat(path.join(owned, 'original-user-data')).then(() => true,
      (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
    if ((await appProcesses(executable)).length || backendAlive || unfinishedBackup) {
      await writeCoordination('cleanup_unconfirmed', { backendPid });
      throw new Error('finder_cleanup_unconfirmed: 原目录备份及活租约保留，主Agent须核验本轮进程');
    }
    if (isolation) await isolation.restore();
    await prepareDatabase('drop', database.database);
    await rm(owned, { recursive: true });
    if (launchId) await requestAppTestLease('release', launchId);
    await writeCoordination(complete ? 'complete' : 'failed_cleaned');
  }
  await writeFile(test.info().outputPath('finder-package-acceptance.json'), JSON.stringify({
    finderOpened: true, packagedUi: true, backendStartedFromAbsolutePython: true, isolatedDatabase: true,
    managerAndHelperObserved: true, normalQuitObserved: true, ownedAppAndBackendGone: true,
    originalUserDataRestored: true, launches: 1, ocrRun: false, wechatRead: false, externalModelCalls: 0,
    signature: 'ad-hoc', developerIdOrNotarization: false,
  }), { mode: 0o600 });
});
