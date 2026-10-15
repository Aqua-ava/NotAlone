import { test, expect } from '@playwright/test';
import { lstat, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { spawnApp, verifyAppTestLease } from './app-test-gate';
import { resolveHeaderChangeSourcePath, resolveSyncProbePath } from '../src/main/backend/bundled-helpers';
import { createAcceptanceCoordinator } from './acceptance-coordinator.mjs';
import { ownedGroupGone } from '../scripts/app-test-lease.mjs';

const stages = new Set(['run', 'permission', 'context', 'initial_capture', 'initial_layout', 'shareable_content',
  'window', 'display', 'source_rect', 'stream_setup', 'stream_start', 'streaming', 'stream_stop', 'finished']);
const reasons = new Set(['begin', 'permission_missing', 'context_unavailable', 'context_changed', 'window_unavailable',
  'display_unsupported', 'source_rect_invalid', 'first_frame', 'output_dimensions', 'pixel_format', 'buffer_lock',
  'missing_buffer', 'frame_limit', 'detector_failed', 'stream_error', 'stream_connection_invalid',
  'stream_connection_interrupted', 'stream_context_missing', 'stream_system_stopped', 'stream_user_stopped',
  'stream_permission_declined', 'stream_missing_entitlements', 'stream_internal', 'stream_invalid_parameter',
  'stream_start_failed', 'operation_failed', 'lease_expired', 'stopped']);
const invalidProtocol = () => new Error('原生验收协议无效或超出有限范围。');
const finiteNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function lines(raw: Buffer, total: number, perLine: number, count: number, complete: boolean): string[] {
  if (raw.length > total) throw invalidProtocol();
  const chunks: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < raw.length; index++) if (raw[index] === 10) {
    chunks.push(raw.subarray(start, index + 1)); start = index + 1;
  }
  if (chunks.length > count || chunks.some(chunk => chunk.length > perLine)
    || raw.length - start > perLine || complete && start !== raw.length) throw invalidProtocol();
  try { return chunks.map(chunk => new TextDecoder('utf-8', { fatal: true }).decode(chunk).slice(0, -1)); }
  catch { throw invalidProtocol(); }
}

export type HeaderDiagnostic = { stage: string; reason: string; elapsedMs: number };
export function parseHeaderDiagnostics(raw: Buffer, complete = true): HeaderDiagnostic[] {
  let previous = 0;
  return lines(raw, 3840, 120, 32, complete).map(line => {
    const match = /^notalone-header-change-v1 ([a-z_]+) ([a-z_]+) (\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.exec(line);
    if (!match || !stages.has(match[1]) || !reasons.has(match[2])) throw invalidProtocol();
    const elapsedMs = Number(match[3]);
    if (!finiteNonnegative(elapsedMs) || elapsedMs < previous) throw invalidProtocol();
    previous = elapsedMs;
    return { stage: match[1], reason: match[2], elapsedMs };
  });
}

export function parseSourceEvents(raw: Buffer, complete = true): Array<'changed' | 'paused'> {
  return lines(raw, 8192, 32, 241, complete).map(line => {
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
        || !['changed', 'paused'].includes(value.event)) throw invalidProtocol();
      return value.event as 'changed' | 'paused';
    } catch { throw invalidProtocol(); }
  });
}

const observationEvents = ['started', 'foregroundAccepted', 'captureRequested', 'captureCompleted',
  'frameReceived', 'headerOcrStarted', 'headerOcrCompleted', 'finished'];
export function summarizeFormalProbe(stdout: string, stderr: Buffer, startedAtMs: number, elapsedMs: number) {
  if (!finiteNonnegative(startedAtMs) || !finiteNonnegative(elapsedMs) || Buffer.byteLength(stdout) > 65_536) throw invalidProtocol();
  const times = new Map<string, number>();
  let lastIndex = -1; let previous = 0;
  for (const line of lines(stderr, 960, 120, 8, true)) {
    const match = /^notalone-observation-v1 ([a-zA-Z]+) (\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.exec(line);
    if (!match) throw invalidProtocol();
    const index = observationEvents.indexOf(match[1]), stamp = Number(match[2]);
    if (index <= lastIndex || !finiteNonnegative(stamp) || stamp < previous) throw invalidProtocol();
    times.set(match[1], stamp); lastIndex = index; previous = stamp;
  }
  if (!times.has('started') || !times.has('finished')) throw invalidProtocol();
  let value;
  try { value = JSON.parse(stdout); } catch { throw invalidProtocol(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidProtocol();
  const status = value.ok === false ? 'failed' : value.ok === true && value.wechat_in_front === false ? 'paused'
    : value.ok === true && value.wechat_in_front === true && value.capture_version === 'automatic-header-v3'
      && typeof value.display_name === 'string' && value.display_name.length > 0
      && value.quality?.layout_verified === true && value.quality?.name_complete === true
      && finiteNonnegative(value.quality?.display_name_confidence)
      && value.quality.display_name_confidence <= 1
      ? (value.quality.display_name_confidence >= 0.90 ? 'recognized' : 'low-confidence') : undefined;
  if (!status || ['recognized', 'low-confidence'].includes(status) && times.size !== 8
    || status === 'paused' && times.size !== 2) throw invalidProtocol();
  const duration = (from: string, to: string) => {
    if (!times.has(from) || !times.has(to)) return null;
    const value = Math.round((times.get(to)! - times.get(from)!) * 1_000_000) / 1000;
    if (!finiteNonnegative(value)) throw invalidProtocol();
    return value;
  };
  // 只保留固定状态与九个数值；stdout中的名称和其他原始字段不返回。
  return { status, startedAtMs, elapsedMs, nativeMs: duration('started', 'finished'),
    captureMs: duration('captureRequested', 'captureCompleted'), ocrMs: duration('headerOcrStarted', 'headerOcrCompleted'),
    captureRequests: Number(times.has('captureRequested')), captureCompletions: Number(times.has('captureCompleted')),
    framesReceived: Number(times.has('frameReceived')), headerOcrCalls: Number(times.has('headerOcrStarted')) };
}

export function nativeAcceptanceResources(executable: string | undefined): string {
  if (!executable || !path.isAbsolute(executable) || path.normalize(executable) !== executable
    || !executable.endsWith('.app/Contents/MacOS/NotAlone')) throw new Error('须指定当前App可执行文件的规范绝对路径。');
  return path.join(path.dirname(path.dirname(executable)), 'Resources');
}

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
type OwnedNative = { child: Awaited<ReturnType<typeof spawnApp>>;
  finished: Promise<{ stdout: Buffer; stderr: Buffer; code: number | null; signal: NodeJS.Signals | null }> };

async function startNative(executable: string, args: string[], environment: Record<string, string>, timeoutMs: number,
  outputLimit: number, diagnosticLimit: number, owned: OwnedNative[],
  onOutput?: (raw: Buffer) => void, onDiagnostic?: (raw: Buffer) => void): Promise<OwnedNative> {
  const child = await spawnApp(executable, args, { stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', ...environment } });
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), failure: Error | undefined;
  const rejectOutput = () => { failure ??= invalidProtocol(); if (alive(child)) child.kill('SIGTERM'); };
  child.stdout?.on('data', (chunk: Buffer) => {
    if (stdout.length + chunk.length > outputLimit) { rejectOutput(); return; }
    stdout = Buffer.concat([stdout, chunk]);
    try { onOutput?.(stdout); } catch { rejectOutput(); }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length + chunk.length > diagnosticLimit) { rejectOutput(); return; }
    stderr = Buffer.concat([stderr, chunk]);
    try { onDiagnostic?.(stderr); } catch { rejectOutput(); }
  });
  const timeout = setTimeout(() => {
    failure ??= new Error('本轮自有原生进程超时。');
    if (alive(child)) child.kill('SIGKILL');
  }, timeoutMs);
  const finished = new Promise<{ stdout: Buffer; stderr: Buffer; code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', () => { clearTimeout(timeout); reject(new Error('本轮原生进程启动失败。')); });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (failure) reject(failure); else resolve({ stdout, stderr, code, signal });
    });
  });
  void finished.catch(() => {});
  const running = { child, finished }; owned.push(running);
  return running;
}

async function stopOwned(running: OwnedNative): Promise<boolean> {
  if (alive(running.child)) running.child.kill('SIGTERM');
  await Promise.race([running.finished.catch(() => {}), pause(1500)]);
  if (alive(running.child)) running.child.kill('SIGKILL');
  await Promise.race([running.finished.catch(() => {}), pause(2500)]);
  await running.child.waitForTestCleanup();
  return !alive(running.child) && ownedGroupGone(running.child);
}

test.skip(process.env.NOTALONE_HEADER_CHANGE_NATIVE_ACCEPTANCE !== '1', '仅主Agent协调的有限独立辅助源验收');
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('同包独立辅助源完整到期并与正式单帧观察并行，记录有限现场切换事件', async () => {
  const lease = await verifyAppTestLease();
  test.setTimeout(Math.max(1000, lease.until - Date.now() + 10_000));
  const resources = nativeAcceptanceResources(process.env.NOTALONE_TEST_APP_EXECUTABLE);
  const root = await realpath(resources);
  const probe = await resolveSyncProbePath(resources), helper = await resolveHeaderChangeSourcePath(resources);
  if (probe !== path.join(root, 'notalone-probe', 'notalone-sync-probe')
    || helper !== path.join(root, 'notalone-probe', 'notalone-header-change-source')) {
    throw new Error('当前包的正式探针与独立辅助源完整性未通过。');
  }
  const directory = process.env.NOTALONE_AUTOMATIC_CONTROL_DIRECTORY;
  if (!directory || !path.isAbsolute(directory)) throw new Error('缺少本轮私有协调目录。');
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()
    || (metadata.mode & 0o077)) throw new Error('本轮协调目录归属不明确。');
  const checkLease = async () => {
    await verifyAppTestLease();
    if (Date.now() >= lease.until - 7000) throw new Error('本轮保留原生进程清理时段。');
  };
  const coordinator = await createAcceptanceCoordinator({ directory, pid: process.pid, checkLease, isAlive: () => true });
  const owned: OwnedNative[] = [];
  const events: Array<{ event: 'changed' | 'paused'; elapsedMs: number }> = [];
  const formal: Array<ReturnType<typeof summarizeFormalProbe>> = [];
  let diagnostics: HeaderDiagnostic[] = [], sourceExit: number | null = null;
  let passed = false, switchesAcknowledged = false, allOwnedGone = false;
  let failure: unknown;
  const ownedPath = test.info().outputPath('header-change-native-owned.json');
  const saveOwnership = () => writeFile(ownedPath, JSON.stringify({ workerPid: process.pid,
    sourcePid: owned[0]?.child.pid ?? null, formalPids: owned.slice(1).map(item => item.child.pid ?? null) }), { mode: 0o600 });
  try {
    console.log('header_change_native_stage: waiting-for-start');
    // 主Agent已把微信置前后写入start；协调信号本身不认证前台或联系人身份。
    await coordinator.waitFor('start');
    await checkLease();
    if (lease.until - Date.now() < 72_000) throw new Error('剩余租约不足以完成一轮55秒源及清理。');
    const beganAt = Date.now();
    const source = await startNative(helper, ['--header-change-source', '--json'],
      { NOTALONE_HEADER_CHANGE_DIAGNOSTICS: '1' }, 64_000, 8192, 3840, owned,
      raw => {
        const current = parseSourceEvents(raw, false);
        for (const event of current.slice(events.length)) events.push({ event, elapsedMs: Date.now() - beganAt });
      }, raw => { diagnostics = parseHeaderDiagnostics(raw, false); });
    await saveOwnership();
    console.log('header_change_native_stage: source-running-switches');
    const switches = coordinator.waitFor('switches');
    void switches.catch(() => {});
    let nextFormal = beganAt + 2500;
    while (alive(source.child)) {
      await checkLease();
      if (Date.now() < nextFormal) { await pause(Math.min(250, nextFormal - Date.now())); continue; }
      if (formal.length >= 24) throw new Error('本轮正式观察达到有限次数。');
      const startedAt = Date.now();
      const running = await startNative(probe, ['--session', '--json', '--minimal-region', '--single-frame'],
        { NOTALONE_OBSERVATION_MEASUREMENTS: '1' }, 3500, 65_536, 960, owned);
      await saveOwnership();
      const result = await running.finished;
      await running.child.waitForTestCleanup();
      if (result.code !== 0 || result.signal !== null) throw new Error('正式单帧观察未正常退出。');
      let stdout;
      try { stdout = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout); } catch { throw invalidProtocol(); }
      formal.push(summarizeFormalProbe(stdout, result.stderr, startedAt, Date.now() - startedAt));
      nextFormal = Math.max(nextFormal + 2500, Date.now() + 20);
    }
    const result = await source.finished;
    await source.child.waitForTestCleanup();
    sourceExit = result.code;
    parseSourceEvents(result.stdout);
    diagnostics = parseHeaderDiagnostics(result.stderr);
    expect(result.code).toBe(0); expect(result.signal).toBe(null);
    expect(diagnostics.some(row => row.stage === 'streaming' && row.reason === 'first_frame')).toBe(true);
    const finished = diagnostics.at(-1);
    expect(finished?.stage).toBe('finished'); expect(finished?.reason).toBe('lease_expired');
    expect(finished!.elapsedMs).toBeGreaterThanOrEqual(55_000);
    expect(finished!.elapsedMs).toBeLessThan(60_000);
    expect(events.at(-1)?.event).toBe('paused');
    expect(events.filter(row => row.event === 'paused')).toHaveLength(1);
    expect(events.filter(row => row.event === 'changed').length).toBeGreaterThanOrEqual(2);
    expect(formal.filter(row => row.status === 'recognized').length).toBeGreaterThanOrEqual(3);
    await switches; switchesAcknowledged = true;
    passed = true;
  } catch (error) { failure = error; }
  finally {
    const stopped = await Promise.allSettled(owned.map(stopOwned));
    allOwnedGone = stopped.every(result => result.status === 'fulfilled' && result.value);
    if (!allOwnedGone) { passed = false; failure ??= new Error('本轮自有原生进程或登记清理未确认。'); }
    try { await coordinator.close(); } catch { passed = false; failure ??= new Error('本轮协调收尾未确认。'); }
    await writeFile(test.info().outputPath('header-change-native-results.json'), JSON.stringify({
      passed, sourceExit, allOwnedGone, switchesAcknowledged, events, diagnostics, formal,
      sourceLaunches: owned.length > 0 ? 1 : 0, formalLaunches: Math.max(0, owned.length - 1),
      identityCertified: false, tccCertified: false, latencyCertified: false, completeSwitchCoverageCertified: false,
      realCliRead: false, externalModelCalls: 0, externalMessagesSent: 0,
    }), { mode: 0o600, flag: 'wx' });
  }
  if (failure) throw failure;
});
