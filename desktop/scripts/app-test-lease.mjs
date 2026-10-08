import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { userInfo } from 'node:os';
import path from 'node:path';

const user = userInfo();
export const leaseRoot = path.join(user.homedir, '.notalone-desktop-tests');
export function leasePath(probeId) {
  return path.join(leaseRoot, probeId ? `probe-${probeId}.lock` : 'interactive.lock');
}

export function gateError(code, message) { return new Error(`${code}: ${message}`); }

async function privateDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== user.uid || (info.mode & 0o077) !== 0) {
    throw gateError('app_test_lease_unsafe', '测试租约目录归属或权限不可核验');
  }
  return info;
}

async function readRecord(directory) {
  const file = await open(path.join(directory, 'lease.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== user.uid || (info.mode & 0o077) !== 0 || info.size > 4096) {
      throw gateError('app_test_lease_unsafe', '租约记录不可核验');
    }
    const record = JSON.parse(await file.readFile('utf8'));
    if (record?.version !== 1 || typeof record.id !== 'string' || !/^[a-f\d-]{36}$/.test(record.id)
      || !['interactive', 'probe'].includes(record.mode) || !Number.isFinite(record.until) || typeof record.project !== 'string') {
      throw gateError('app_test_lease_unsafe', '租约记录不可核验');
    }
    return record;
  } finally { await file.close(); }
}

export async function acquireLease(options) {
  await mkdir(leaseRoot, { mode: 0o700, recursive: true });
  await privateDirectory(leaseRoot);
  const directory = leasePath(options.mode === 'probe' ? options.id : undefined);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw gateError('app_test_locked', '同一用户已有验收租约，或上轮收尾尚未确认；禁止抢占陈旧锁');
    throw gateError('app_test_lease_unsafe', '测试租约不可创建');
  }
  const info = await privateDirectory(directory);
  const id = randomUUID();
  const record = { version: 1, id, mode: options.mode, runnerPid: process.pid, startedAt: Date.now(),
    until: options.until, coordinator: options.coordinator ?? 'safe-probe', project: options.desktop };
  try { await writeFile(path.join(directory, 'lease.json'), JSON.stringify(record), { mode: 0o600, flag: 'wx' }); }
  catch (error) { await rm(directory, { recursive: true }); throw error; }
  return {
    directory, record,
    async release() {
      const current = await privateDirectory(directory);
      const stored = await readRecord(directory);
      if (current.ino !== info.ino || current.dev !== info.dev || stored.id !== id) {
        throw gateError('app_test_lease_unsafe', '租约已改变，保留现场等待核验');
      }
      await rm(directory, { recursive: true });
    },
  };
}

export async function leaseStatus(probeId) {
  const directory = leasePath(probeId);
  try {
    await privateDirectory(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent' };
    throw gateError('app_test_lease_unsafe', '租约状态不可核验，禁止启动或自动解锁');
  }
  try {
    await privateDirectory(leaseRoot);
    const record = await readRecord(directory);
    // 只报告归属线索；文件或 PID 不能证明活 runner/孩子均已结束，不自动解锁。
    return { state: 'needs-owner-verification', id: record.id, runnerPid: record.runnerPid,
      project: record.project, coordinator: record.coordinator, until: record.until };
  } catch {
    throw gateError('app_test_lease_unsafe', '租约状态不可核验，禁止启动或自动解锁');
  }
}

export async function serveLease(lease, options) {
  const token = randomBytes(32).toString('hex');
  const active = new Set();
  let launches = 0;
  let accepting = true;
  const monotonicDeadline = performance.now() + Math.max(0, options.until - Date.now());
  const server = createServer((socket) => {
    let input = '';
    socket.setTimeout(1000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      input += chunk;
      if (input.length > 4096) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      let result;
      try {
        const request = JSON.parse(input.slice(0, input.indexOf('\n')));
        if (request.token !== token || request.id !== lease.record.id || request.project !== lease.record.project) {
          throw gateError('app_test_unapproved', '没有本 runner 的活租约');
        }
        if (request.action === 'release') {
          active.delete(request.launchId);
          result = { until: options.until };
        } else {
          if (options.mode !== 'interactive' && request.action !== 'probe') throw gateError('app_test_unapproved', '安全探针不授予 App 启动资格');
          if (!accepting || Date.now() >= options.until || performance.now() >= monotonicDeadline) throw gateError('app_test_expired', '验收时段已到期或正在收尾');
          if (!['check', 'launch', 'probe'].includes(request.action)) throw gateError('app_test_arguments', '未知租约操作');
          if (request.action === 'launch' || request.action === 'probe') {
            if (launches >= (options.budget ?? 1)) throw gateError('app_test_budget', '本轮启动预算已用完');
            launches += 1;
            const launchId = randomUUID();
            active.add(launchId);
            result = { until: options.until, launchId };
          } else result = { until: options.until };
        }
      } catch (error) { result = { error: error.message.startsWith('app_test_') ? error.message : 'app_test_arguments: 租约请求不可核验' }; }
      socket.end(`${JSON.stringify(result)}\n`);
    });
  });
  const socketPath = path.join(lease.directory, 'runner.sock');
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
  } catch {
    await new Promise((resolve) => server.close(resolve));
    throw gateError('app_test_lease_unsafe', '本机测试租约通道不可建立');
  }
  return {
    environment: { NOTALONE_APP_TEST_TOKEN: token, NOTALONE_APP_TEST_LEASE: lease.record.id },
    stop() { accepting = false; },
    get activeCount() { return active.size; },
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}

export async function requestAppTestLease(action, launchId, probeId) {
  if (!/^[a-f\d]{64}$/.test(process.env.NOTALONE_APP_TEST_TOKEN ?? '') || !process.env.NOTALONE_APP_TEST_LEASE) {
    throw gateError('app_test_unapproved', '真实 App 测试只允许从已协调的 test:app 入口运行；App 未运行');
  }
  const directory = leasePath(probeId);
  try {
    await privateDirectory(leaseRoot);
    await privateDirectory(directory);
    const record = await readRecord(directory);
    const socketPath = path.join(directory, 'runner.sock');
    const info = await lstat(socketPath);
    if (!info.isSocket() || info.uid !== user.uid || (info.mode & 0o077) !== 0 || record.id !== process.env.NOTALONE_APP_TEST_LEASE) {
      throw gateError('app_test_lease_unsafe', '活租约来源不可核验');
    }
    return await new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      let input = '';
      const fail = () => { socket.destroy(); reject(gateError('app_test_lease_unavailable', 'runner 不可确认，禁止启动 App')); };
      socket.setTimeout(1000, fail);
      socket.on('error', fail);
      socket.on('connect', () => socket.write(`${JSON.stringify({ action, launchId,
        token: process.env.NOTALONE_APP_TEST_TOKEN, id: record.id, project: process.cwd() })}\n`));
      socket.on('data', (chunk) => { input += chunk; if (input.length > 4096) fail(); });
      socket.on('end', () => {
        try {
          const result = JSON.parse(input);
          if (result.error) throw new Error(result.error);
          if (!Number.isFinite(result.until) || (['launch', 'probe'].includes(action) && !/^[a-f\d-]{36}$/.test(result.launchId ?? ''))) {
            throw gateError('app_test_lease_unsafe', 'runner 响应不可核验');
          }
          resolve(result);
        } catch (error) { reject(error); }
      });
    });
  } catch (error) {
    if (error.message.startsWith('app_test_')) throw error;
    throw gateError('app_test_lease_unavailable', '活租约不可确认，禁止启动 App');
  }
}

// 仅探测本轮已创建的进程组；任何未知/EPERM/疑似 PID 复用均保留租约，不发终止信号。
export function ownedGroupGone(child) {
  if (!child.pid) return true;
  try { process.kill(-child.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}
