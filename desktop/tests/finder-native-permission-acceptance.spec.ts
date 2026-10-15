import { test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { requestAppTestLease } from '../scripts/app-test-lease.mjs';
import { verifyAppTestLease } from './app-test-gate';
import { createFinderUserData } from './finder-user-data';
import { readConnection } from '../src/main/backend/connection';
import { resolveHeaderChangeSourcePath, resolveSyncProbePath } from '../src/main/backend/bundled-helpers';
import { readAcceptanceFile } from './real-foreground-credential';
import { isolatedAppEnvironment } from './isolated-environment';

type ReceiptStage = 'finder' | 'wechat' | 'helper' | 'quit';
const receiptFields: Record<ReceiptStage, readonly string[]> = {
  finder: ['finderOpened'], wechat: ['syncEnabled', 'managerHidden', 'wechatForeground'],
  helper: ['helperOpened', 'helperFocused'], quit: ['normalQuitRequested'],
};

// 收据只描述主Agent实际操作；不包含TCC、截图、姓名或识别成功的认证字段。
export function acceptedFinderReceipt(value: unknown, runId: string, stage: ReceiptStage): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const fields = receiptFields[stage];
  const keys = ['schemaVersion', 'runId', 'stage', ...fields];
  return Object.keys(record).length === keys.length && Object.keys(record).every(key => keys.includes(key))
    && record.schemaVersion === 1 && record.runId === runId && record.stage === stage
    && fields.every(key => record[key] === true);
}

type CleanupProof = { normalQuitReceipt: boolean; appGone: boolean; backendKnown: boolean;
  backendGone: boolean; nativeGone: boolean; handshakeGone: boolean };
export function finderCleanupAllowed(proof: Partial<CleanupProof>): boolean {
  return ['normalQuitReceipt', 'appGone', 'backendKnown', 'backendGone', 'nativeGone', 'handshakeGone']
    .every(key => proof[key as keyof CleanupProof] === true);
}

type ProcessRow = { pid: number; parent: number; command: string };
function processRows(text: string, uid: number): ProcessRow[] {
  return text.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match && Number(match[3]) === uid
      ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[4] }] : [];
  });
}

export function notAloneProcessPids(text: string, uid: number): number[] {
  return processRows(text, uid).filter(row => /\/NotAlone(?:App)?\.app\/Contents\//.test(row.command)
    || ['notalone-sync-probe', 'notalone-header-change-source'].includes(path.basename(row.command)))
    .map(row => row.pid);
}

export function finderNativeProcessSample(text: string, uid: number, paths: { probe: string; helper: string },
  appPid: number, backendPid: number) {
  const result = { probePids: [] as number[], helperPids: [] as number[], unownedNativePids: [] as number[] };
  for (const row of processRows(text, uid)) {
    if (row.command === paths.probe) {
      (row.parent === backendPid ? result.probePids : result.unownedNativePids).push(row.pid);
    } else if (row.command === paths.helper) {
      (row.parent === appPid ? result.helperPids : result.unownedNativePids).push(row.pid);
    }
  }
  return result;
}

export function nativeProbeArgumentKind(command: string, executable: string): 'single-frame' | 'legacy-session' | 'unknown' {
  const argumentsText = command.trim().slice(executable.length);
  if (!command.trim().startsWith(`${executable} `)) return 'unknown';
  if (argumentsText === ' --session --json --minimal-region --single-frame') return 'single-frame';
  if (argumentsText === ' --session --json') return 'legacy-session';
  return 'unknown';
}

export function finderPythonBootstrap(python: string, environment: Record<string, string>): string {
  return `#!${python} -I\nimport json, os, sys\n` +
    `os.execve(${JSON.stringify(python)}, [${JSON.stringify(python)}, *sys.argv[1:]], ` +
    `json.loads(${JSON.stringify(JSON.stringify(environment))}))\n`;
}

test.skip(process.env.NOTALONE_FINDER_NATIVE_PERMISSION_ACCEPTANCE !== '1', '仅主Agent从Finder实际打开当前签名包的权限归属验收');
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

const execute = promisify(execFile);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const requireProof = (value: unknown, code: string) => { if (!value) throw new Error(code); };
async function processSnapshot(): Promise<string> {
  try { return (await execute('/bin/ps', ['-axo', 'pid=,ppid=,uid=,comm=', '-ww'],
    { timeout: 5000, maxBuffer: 1_048_576 })).stdout; }
  catch { throw new Error('finder_process_snapshot_unavailable'); }
}
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
async function backendProcesses(): Promise<number[]> {
  try {
    const { stdout } = await execute('/usr/bin/pgrep', ['-u', String(process.getuid!()), '-f', 'notalone[.]server[.]command'],
      { timeout: 5000, maxBuffer: 65_536 });
    return stdout.trim().split('\n').filter(Boolean).map(Number);
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return [];
    throw new Error('finder_backend_snapshot_unavailable');
  }
}
async function readReceipt(selected: string): Promise<unknown> {
  let file;
  try { file = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const before = await file.stat();
    requireProof(before.isFile() && before.uid === process.getuid!() && before.nlink === 1
      && !(before.mode & 0o077) && before.size <= 4096, 'finder_receipt_unsafe');
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    requireProof(bytesRead === before.size && before.ino === after.ino && before.size === after.size
      && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'finder_receipt_changed');
    try { return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')); }
    catch { throw new Error('finder_receipt_invalid'); }
  } finally { await file.close(); }
}

test('Finder独立打开当前包，记录正式单帧与独立顶部源尝试后正常退出恢复原目录，TCC由主Agent另核', async () => {
  const lease = await verifyAppTestLease();
  test.setTimeout(Math.max(1000, Math.min(8 * 60_000, lease.until - Date.now() - 10_000)));
  requireProof(process.env.CONDA_DEFAULT_ENV === 'NotAlone' && process.env.CONDA_PREFIX, 'finder_conda_required');
  const selected = process.env.NOTALONE_TEST_APP_EXECUTABLE;
  requireProof(selected && path.isAbsolute(selected), 'finder_absolute_package_required');
  const executable = await realpath(selected!);
  requireProof(executable.endsWith('/NotAlone.app/Contents/MacOS/NotAlone'), 'finder_package_invalid');
  const appBundlePath = path.dirname(path.dirname(path.dirname(executable)));
  const resources = path.join(appBundlePath, 'Contents/Resources');
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', appBundlePath], { timeout: 15_000 });
  const probe = await resolveSyncProbePath(resources);
  const helper = await resolveHeaderChangeSourcePath(resources);
  requireProof(probe && helper && probe !== helper, 'finder_independent_native_group_required');
  const nativePaths = { probe: probe!, helper: helper! };
  const hashes: Record<string, string> = {};
  for (const [key, file] of Object.entries({ app: executable, probe: probe!, helper: helper!,
    core: path.join(resources, 'notalone-probe/libNotAloneSyncCore.dylib'), manifest: path.join(resources, 'notalone-probe/manifest.json') })) {
    hashes[key] = createHash('sha256').update(await readAcceptanceFile(file, 268_435_456, false)).digest('hex');
  }
  const uid = process.getuid!();
  requireProof(notAloneProcessPids(await processSnapshot(), uid).length === 0
    && (await backendProcesses()).length === 0, 'finder_other_runtime_present');
  const directory = path.join(homedir(), 'Library/Application Support/NotAloneDesktop');
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const exists = await lstat(path.join(directory, name)).then(() => true,
      (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
    requireProof(!exists, 'finder_user_singleton_present');
  }
  const seconds = Number(process.env.NOTALONE_FINDER_NATIVE_SECONDS ?? 45);
  requireProof(Number.isInteger(seconds) && seconds >= 30 && seconds <= 60, 'finder_observation_duration_invalid');
  const owned = await realpath(await mkdtemp(path.join(path.dirname(directory), '.notalone-finder-native-')));
  await chmod(owned, 0o700);
  const runId = randomUUID();
  const coordinationPath = test.info().outputPath('finder-native-coordination.json');
  const receiptPath = path.join(owned, 'coordinator-receipt.json');
  const infoPath = path.join(owned, 'backend.info');
  const realPython = await realpath(path.join(process.env.CONDA_PREFIX!, 'bin/python'));
  const project = await realpath(path.resolve('..'));
  const databaseScript = path.join(project, 'backend/tests/integration/server/binding_consent_support.py');
  const preparationEnvironment = isolatedAppEnvironment(owned, { PYTHONPATH: path.join(project, 'backend/src') });
  let data: { database_name: string; database_url: string; owner_id: string } | undefined;
  let isolation: Awaited<ReturnType<typeof createFinderUserData>> | undefined;
  let launchId: string | undefined;
  let appPid: number | undefined;
  let backendPid: number | undefined;
  let restored = false;
  let complete = false;
  const proof: CleanupProof = { normalQuitReceipt: false, appGone: false, backendKnown: false,
    backendGone: false, nativeGone: false, handshakeGone: false };
  const probePids = new Set<number>();
  const helperPids = new Set<number>();
  const singleFramePids = new Set<number>();
  const legacySessionPids = new Set<number>();
  const unknownArgumentPids = new Set<number>();
  const probeKinds = new Map<number, ReturnType<typeof nativeProbeArgumentKind>>();
  const wechatSingleFramePids = new Set<number>();
  const wechatHelperPids = new Set<number>();
  let observingWechat = false;
  let observationSamples = 0;
  let helperSamples = 0;
  const coordinate = async (phase: string, expectedReceiptStage?: ReceiptStage) => {
    const temporary = `${coordinationPath}.tmp`;
    await writeFile(temporary, JSON.stringify({ phase, runId, expectedReceiptStage, until: lease.until,
      appBundlePath, executable, directory, ownedDirectory: owned, infoPath, receiptPath,
      databaseName: data?.database_name ?? null, appPid: appPid ?? null, backendPid: backendPid ?? null, launchId: launchId ?? null,
      helperPids: [...helperPids], originalIdentity: isolation?.originalIdentity ?? null,
      ownedIdentity: isolation?.ownedIdentity ?? null, hashes, observationSeconds: seconds,
    }), { mode: 0o600 });
    await rename(temporary, coordinationPath);
  };
  const checkLease = async () => {
    await verifyAppTestLease();
    requireProof(Date.now() < lease.until - 15_000, 'finder_cleanup_time_reserved');
  };
  const until = async <T,>(read: () => Promise<T>, accept: (value: T) => boolean, timeout: number, code: string): Promise<T> => {
    const end = Math.min(Date.now() + timeout, lease.until - 15_000);
    while (Date.now() < end) {
      await checkLease();
      const value = await read();
      if (accept(value)) return value;
      await wait(200);
    }
    throw new Error(code);
  };
  const waitForReceipt = (stage: ReceiptStage) => until(() => readReceipt(receiptPath),
    value => acceptedFinderReceipt(value, runId, stage), 180_000, 'finder_stage_receipt_missing');
  const sample = async () => {
    const raw = await processSnapshot();
    const rows = processRows(raw, uid);
    requireProof(rows.some(row => row.pid === appPid && row.command === executable), 'finder_app_exited');
    requireProof(rows.some(row => row.pid === backendPid && row.parent === appPid), 'finder_backend_parent_changed');
    const natives = finderNativeProcessSample(raw, uid, nativePaths, appPid!, backendPid!);
    requireProof(natives.unownedNativePids.length === 0, 'finder_native_parent_changed');
    for (const pid of natives.helperPids) { helperPids.add(pid); if (observingWechat) wechatHelperPids.add(pid); }
    for (const pid of natives.probePids) {
      if (!probePids.has(pid)) {
        probePids.add(pid);
        let command: string | undefined;
        try { command = (await execute('/bin/ps', ['-p', String(pid), '-o', 'args=', '-ww'], { timeout: 2000 })).stdout.trim(); }
        catch (error) { if ((error as { code?: unknown }).code !== 1) throw new Error('finder_native_arguments_unavailable'); }
        const kind = command ? nativeProbeArgumentKind(command, probe!) : 'unknown';
        probeKinds.set(pid, kind);
        (kind === 'single-frame' ? singleFramePids : kind === 'legacy-session' ? legacySessionPids : unknownArgumentPids).add(pid);
      }
      if (observingWechat && probeKinds.get(pid) === 'single-frame') wechatSingleFramePids.add(pid);
    }
    observationSamples++;
    if (natives.helperPids.length) helperSamples++;
  };
  try {
    await coordinate('preparing');
    data = JSON.parse((await execute(realPython, [databaseScript, 'create', 'single-account'],
      { env: preparationEnvironment, timeout: 70_000 })).stdout);
    requireProof(data && /^notalone_binding_[0-9a-f]{32}_test$/.test(data.database_name)
      && /^[0-9a-f-]{36}$/.test(data.owner_id), 'finder_database_ownership_invalid');
    isolation = await createFinderUserData(directory, owned);
    const envFilePath = path.join(owned, 'synthetic.env');
    const python = path.join(owned, 'isolated-python');
    const environment: Record<string, string> = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
      PYTHONPATH: path.join(project, 'backend/src'), PYTHONNOUSERSITE: '1', NOTALONE_DISABLE_DOTENV: '1',
      NOTALONE_ENV_FILE: envFilePath, NOTALONE_DATABASE_URL: data!.database_url, NOTALONE_OWNER_ID: data!.owner_id,
      NOTALONE_BACKEND_INFO: infoPath, NOTALONE_WECHAT_CLI: path.join(owned, 'unavailable-cli'),
      NOTALONE_SYNC_PROBE: probe!, NOTALONE_FOREGROUND_LAYOUT: path.join(owned, 'unavailable-layout.json'),
      NOTALONE_DEEPSEEK_API_KEY: '', DEEPSEEK_API_KEY: '', NOTALONE_DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
      LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false', LANGCHAIN_TRACING: 'false' };
    if (process.env.PGPORT) {
      requireProof(/^\d+$/.test(process.env.PGPORT) && Number(process.env.PGPORT) > 0
        && Number(process.env.PGPORT) <= 65535, 'finder_pgport_invalid');
      environment.PGPORT = process.env.PGPORT;
    }
    await writeFile(envFilePath, Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    await writeFile(python, finderPythonBootstrap(realPython, environment), { mode: 0o700, flag: 'wx' });
    await writeFile(path.join(directory, 'backend-launch.json'), JSON.stringify({ pythonExecutable: python,
      projectDirectory: project, envFilePath, backendInfoPath: infoPath,
      wechatCliPath: environment.NOTALONE_WECHAT_CLI, syncProbePath: probe }), { mode: 0o600, flag: 'wx' });
    const permit = await requestAppTestLease('launch');
    launchId = permit.launchId;
    await coordinate('waiting_finder', 'finder');
    console.log(`finder_native_coordination: ${coordinationPath}`);
    await waitForReceipt('finder');
    const appRows = await until(async () => processRows(await processSnapshot(), uid).filter(row => row.command === executable),
      rows => rows.length === 1, 60_000, 'finder_app_not_found');
    appPid = appRows[0].pid;
    const connection = await until(() => readConnection(infoPath), value => value !== undefined, 60_000, 'finder_backend_not_ready');
    backendPid = connection!.pid;
    proof.backendKnown = true;
    await sample();
    const runtime = await fetch(`http://${connection!.address}/api/runtime/status`, {
      redirect: 'error', headers: { Authorization: `Bearer ${connection!.token}` }, signal: AbortSignal.timeout(5000) });
    requireProof(runtime.status === 200 && (await runtime.json()).state === 'running', 'finder_authenticated_backend_unavailable');
    await coordinate('backend_ready', 'wechat');
    await waitForReceipt('wechat');
    await coordinate('observing_wechat');
    observingWechat = true;
    const observationEnd = Date.now() + seconds * 1000;
    while (Date.now() < observationEnd) { await checkLease(); await sample(); await wait(100); }
    observingWechat = false;
    requireProof(wechatSingleFramePids.size > 0 && wechatHelperPids.size > 0, 'finder_native_attempt_missing');
    await coordinate('waiting_helper', 'helper');
    await waitForReceipt('helper');
    await until(async () => [...helperPids].every(pid => !pidAlive(pid)), Boolean, 5000, 'finder_helper_stop_unconfirmed');
    await coordinate('waiting_quit', 'quit');
    await waitForReceipt('quit');
    proof.normalQuitReceipt = true;
    await until(async () => notAloneProcessPids(await processSnapshot(), uid).length === 0, Boolean, 15_000, 'finder_app_stop_unconfirmed');
    proof.appGone = true;
    await until(async () => !pidAlive(backendPid!), Boolean, 15_000, 'finder_backend_stop_unconfirmed');
    proof.backendGone = true;
    proof.nativeGone = [...probePids, ...helperPids].every(pid => !pidAlive(pid));
    proof.handshakeGone = await readConnection(infoPath) === undefined;
    requireProof(finderCleanupAllowed(proof), 'finder_normal_quit_unconfirmed');
    complete = true;
  } finally {
    // Finder实例不是runner的孩子；正常菜单退出未证实就保留原备份、库和租约，不发清理信号。
    const writeResults = (cleanupConfirmed: boolean) => writeFile(test.info().outputPath('finder-native-results.json'), JSON.stringify({
      complete, normalQuitReceipt: proof.normalQuitReceipt, appGone: proof.appGone, backendGone: proof.backendGone,
      nativeGone: proof.nativeGone, handshakeGone: proof.handshakeGone, originalUserDataRestored: restored, cleanupConfirmed,
      appPid, backendPid, probePids: [...probePids], helperPids: [...helperPids], hashes,
      observationSeconds: seconds, observationSamples, helperSamples, singleFramePidCount: singleFramePids.size,
      legacySessionPidCount: legacySessionPids.size, unknownArgumentPidCount: unknownArgumentPids.size,
      wechatSingleFramePidCount: wechatSingleFramePids.size, wechatHelperPidCount: wechatHelperPids.size,
      pidSamplingOnly: true, nativeCaptureSuccessCertified: false, tccAttributionCertified: false,
      identityCertified: false, streamCoverageCertified: false, realCliRead: false,
      externalModelCalls: 0, externalMessagesSent: 0,
    }), { mode: 0o600 });
    await writeResults(false);
    const noRuntime = notAloneProcessPids(await processSnapshot(), uid).length === 0
      && (await backendProcesses()).length === 0;
    const unfinishedBackup = !isolation && await lstat(path.join(owned, 'original-user-data')).then(() => true,
      (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
    if (!data || !noRuntime || unfinishedBackup || launchId && !finderCleanupAllowed(proof)) {
      await coordinate('cleanup_unconfirmed');
      throw new Error('finder_cleanup_unconfirmed: 保留原配置备份、测试库与活租约，由主Agent核验');
    }
    try {
      if (isolation) { await isolation.restore(); restored = true; }
      await execute(realPython, [databaseScript, 'drop', data.database_name], { env: preparationEnvironment, timeout: 15_000 });
      if (launchId) await requestAppTestLease('release', launchId);
      await coordinate(complete ? 'complete' : 'failed_cleaned');
      await writeResults(true);
      await rm(owned, { recursive: true });
    } catch {
      await coordinate('cleanup_unconfirmed');
      await writeResults(false);
      throw new Error('finder_restore_unconfirmed: 保留剩余本轮资源，主Agent须核验恢复状态');
    }
  }
});
