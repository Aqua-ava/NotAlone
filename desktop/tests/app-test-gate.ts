import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { ownedGroupGone, requestAppTestLease } from '../scripts/app-test-lease.mjs';

export const verifyAppTestLease = () => requestAppTestLease('check');
const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

async function releaseAfterExit(child: ChildProcess, launchId: string): Promise<void> {
  const limit = Date.now() + 1500;
  while (Date.now() < limit && !ownedGroupGone(child)) await new Promise((resolve) => setTimeout(resolve, 50));
  if (ownedGroupGone(child)) await requestAppTestLease('release', launchId).catch(() => {});
}

type LeaseShutdown = {
  gracefulStop: () => void | Promise<void>;
  terminateAfterMs?: number;
  killAfterMs: number;
};

function monitorLease(child: ChildProcess, until: number, shutdown: LeaseShutdown): () => void {
  let stopping = false;
  let checking = false;
  const escalation: ReturnType<typeof setTimeout>[] = [];
  const dispose = () => {
    clearInterval(heartbeat);
    escalation.forEach(clearTimeout);
  };
  const cleanup = async () => {
    if (stopping || !alive(child)) return;
    stopping = true;
    // 只操作此 launch 返回并仍存活的 ChildProcess；强制回收不算产品停读通过。
    if (shutdown.terminateAfterMs !== undefined) {
      escalation.push(setTimeout(() => { if (alive(child)) child.kill('SIGTERM'); }, shutdown.terminateAfterMs));
    }
    escalation.push(setTimeout(() => { if (alive(child)) child.kill('SIGKILL'); }, shutdown.killAfterMs));
    // 正常关闭失败也保留升级时限，直到拥有的孩子退出；不释放未知的启动登记。
    try { await shutdown.gracefulStop(); } catch {}
  };
  const heartbeat = setInterval(async () => {
    if (checking || stopping || !alive(child)) return;
    checking = true;
    try { if (Date.now() >= until) throw new Error('expired'); await verifyAppTestLease(); }
    catch { void cleanup(); }
    finally { checking = false; }
  }, 500);
  heartbeat.unref();
  child.once('exit', dispose);
  return dispose;
}

function watchApp(app: ElectronApplication, launchId: string, until: number): void {
  const child = app.process();
  const originalClose = app.close.bind(app);
  const dispose = monitorLease(child, until, { gracefulStop: originalClose, terminateAfterMs: 3000, killAfterMs: 5000 });
  let finished: Promise<void> | undefined;
  const finish = () => {
    dispose();
    finished ??= releaseAfterExit(child, launchId);
    return finished;
  };
  app.once('close', () => { void finish(); });
  app.close = async () => { await originalClose(); await finish(); };
}

// 配置与 fixture 都加载此门禁，覆盖原始 API 以及独立重启调用；不改生产窗口行为。
const protectedElectron = electron as typeof electron & { notaloneLaunchGate?: boolean };
if (!protectedElectron.notaloneLaunchGate) {
  const originalLaunch = electron.launch.bind(electron);
  electron.launch = async (options) => {
    const permit = await requestAppTestLease('launch');
    if (Date.now() >= permit.until) throw new Error('app_test_expired: 验收时段已到期，禁止启动 App');
    // Playwright 的启动等待也不得超出本次时段；失败的登记保留供主 Agent 核验。
    const requestedTimeout = options?.timeout && options.timeout > 0 ? options.timeout : 30_000;
    const app = await originalLaunch({ ...options, timeout: Math.max(1, Math.min(requestedTimeout, permit.until - Date.now())) });
    watchApp(app, permit.launchId!, permit.until);
    return app;
  };
  protectedElectron.notaloneLaunchGate = true;
}

export const launchApp = (options: Parameters<typeof electron.launch>[0]) => electron.launch(options);

export async function spawnApp(executable: string, args: string[], options: SpawnOptions): Promise<ChildProcess> {
  const permit = await requestAppTestLease('launch');
  if (Date.now() >= permit.until) throw new Error('app_test_expired: 验收时段已到期，禁止启动 App');
  const child = spawn(executable, args, { ...options, detached: true });
  child.once('exit', () => { void releaseAfterExit(child, permit.launchId!); });
  monitorLease(child, permit.until, {
    gracefulStop: () => { if (alive(child)) child.kill('SIGTERM'); }, killAfterMs: 3000,
  });
  return child;
}

export default async function appTestGlobalSetup(): Promise<void> { await verifyAppTestLease(); }
