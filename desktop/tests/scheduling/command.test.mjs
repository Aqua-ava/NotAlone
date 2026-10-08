import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { leasePath } from '../../scripts/app-test-lease.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const command = path.join(desktop, 'scripts/test-app.mjs');

function start(args, options = {}) {
  const { commandPath = command, ...processOptions } = options;
  const child = spawn(process.execPath, [commandPath, ...args], { cwd: desktop, ...processOptions, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const done = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal, output })));
  async function ready() {
    const limit = Date.now() + 3000;
    while (!output.includes('app_test_lease_acquired')) {
      if (child.exitCode !== null || Date.now() >= limit) throw new Error(output || '安全探针未就绪');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return { child, done, ready, output: () => output };
}

function probe(id, hold = 0, until = Date.now() + 10_000) {
  return ['--probe', id, '--hold-ms', String(hold), '--until', new Date(until).toISOString()];
}

test('未给出协调及预约时段的显式验收拒绝执行，并说明 App 未运行', () => {
  const result = spawnSync(process.execPath, [command, '--interactive'], { cwd: desktop, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /app_test_unapproved/);
  assert.match(result.stderr, /App 未运行/);
});

test('同一用户的两份独立命令副本与不同 TMPDIR 互斥，正常收尾后下一轮才能领取', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-scheduling-'));
  for (const file of ['scripts/test-app.mjs', 'scripts/app-test-lease.mjs', 'tests/scheduling/probe-child.mjs']) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await copyFile(path.join(desktop, file), path.join(directory, file));
  }
  const other = { commandPath: path.join(directory, 'scripts/test-app.mjs'), cwd: directory, env: { ...process.env, TMPDIR: directory } };
  const id = randomUUID();
  const first = start(probe(id, 400));
  try {
    await first.ready();
    const second = await start(probe(id), other).done;
    assert.equal(second.code, 2);
    assert.match(second.output, /app_test_locked/);
    assert.equal((await first.done).code, 0);
    const next = await start(probe(id), other).done;
    assert.equal(next.code, 0);
    assert.match(next.output, /App 未运行/);
  } finally {
    if (first.child.exitCode === null) first.child.kill('SIGTERM');
    await first.done;
    await rm(directory, { recursive: true, force: true });
  }
});

test('独立 Playwright worker 中的原始 Electron API 也不能绕过门禁', () => {
  const result = spawnSync(process.execPath, [path.join(desktop, 'node_modules/playwright/cli.js'), 'test',
    '--config', 'tests/scheduling/playwright.config.ts'], { cwd: desktop, encoding: 'utf8', timeout: 8000,
    env: { ...process.env, NOTALONE_APP_TEST_TOKEN: '', NOTALONE_APP_TEST_LEASE: '' } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('探针启动预算被实际租约拒绝，到期收尾后可以重新领取', async () => {
  const id = randomUUID();
  const result = await start(probe(id, 5000, Date.now() + 700)).done;
  assert.equal(result.code, 124);
  assert.match(result.output, /app_test_budget/);
  assert.match(result.output, /app_test_expired/);
  assert.equal((await start(probe(id)).done).code, 0);
});

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`${signal} 收尾只作用本轮合成孩子，完成后解除租约`, async () => {
    const id = randomUUID();
    const running = start(probe(id, 5000));
    await running.ready();
    running.child.kill(signal);
    const result = await running.done;
    assert.equal(result.code, code, result.output);
    assert.equal((await start(probe(id)).done).code, 0);
  });
}

test('runner 崩溃后保留不确定租约，不能以时间到期或 PID 猜测自动抢占', async () => {
  const id = randomUUID();
  const running = start(probe(id, 5000));
  try {
    await running.ready();
    running.child.kill('SIGKILL');
    assert.equal((await running.done).signal, 'SIGKILL');
    const next = await start(probe(id)).done;
    assert.equal(next.code, 2);
    assert.match(next.output, /app_test_locked/);
    const status = await start(['--status', '--probe', id]).done;
    assert.match(status.output, /needs-owner-verification/);
    assert.doesNotMatch(status.output, /token/);
  } finally {
    // 仅删除本测试创建并已结束的固定合成探针资源，绝不清理 interactive.lock。
    await rm(leasePath(id), { recursive: true, force: true });
  }
});

test('损坏且未知归属的陈旧记录失败关闭，既不读取原始内容也不自动删除', async () => {
  const id = randomUUID();
  const directory = leasePath(id);
  await mkdir(directory, { mode: 0o700, recursive: true });
  try {
    await writeFile(path.join(directory, 'lease.json'), '{broken', { mode: 0o600 });
    const status = await start(['--status', '--probe', id]).done;
    assert.equal(status.code, 2);
    assert.match(status.output, /app_test_lease_unsafe/);
    assert.doesNotMatch(status.output, /broken/);
    assert.match((await start(probe(id)).done).output, /app_test_locked/);
  } finally { await rm(directory, { recursive: true }); }
});

test('锁目录已创建但租约记录尚未写入时不可核验，不能显示 absent', async () => {
  const id = randomUUID();
  const directory = leasePath(id);
  await mkdir(directory, { mode: 0o700, recursive: true });
  try {
    const status = await start(['--status', '--probe', id]).done;
    assert.equal(status.code, 2, status.output);
    assert.match(status.output, /app_test_lease_unsafe/);
    assert.doesNotMatch(status.output, /"state":"absent"/);
    assert.match((await start(probe(id)).done).output, /app_test_locked/);
  } finally { await rm(directory, { recursive: true }); }
});

test('到期记录即使写着当前活 PID 也不推断归属或抢占', async () => {
  const id = randomUUID();
  const directory = leasePath(id);
  await mkdir(directory, { mode: 0o700, recursive: true });
  try {
    await writeFile(path.join(directory, 'lease.json'), JSON.stringify({ version: 1, id: randomUUID(), mode: 'probe',
      runnerPid: process.pid, until: Date.now() - 1000, project: desktop }), { mode: 0o600 });
    assert.match((await start(['--status', '--probe', id]).done).output, /needs-owner-verification/);
    assert.match((await start(probe(id)).done).output, /app_test_locked/);
  } finally { await rm(directory, { recursive: true }); }
});

test('无写端 FIFO 租约记录不会阻塞状态命令，仍拒绝继续验收', async () => {
  const id = randomUUID();
  const directory = leasePath(id);
  await mkdir(directory, { mode: 0o700, recursive: true });
  try {
    const created = spawnSync('mkfifo', [path.join(directory, 'lease.json')], { encoding: 'utf8' });
    assert.equal(created.status, 0);
    const status = spawnSync(process.execPath, [command, '--status', '--probe', id], { cwd: desktop, encoding: 'utf8', timeout: 2000 });
    assert.equal(status.status, 2, status.stderr);
    assert.match(status.stderr, /app_test_lease_unsafe/);
    assert.match((await start(probe(id)).done).output, /app_test_locked/);
  } finally { await rm(directory, { recursive: true }); }
});

test('直接 Playwright 主配置在 fixture 之前拒绝，未运行真实 App', () => {
  const result = spawnSync(process.execPath, [path.join(desktop, 'node_modules/playwright/cli.js'), 'test', 'tests/windows.spec.ts'],
    { cwd: desktop, encoding: 'utf8', timeout: 8000,
      env: { ...process.env, NOTALONE_TEST_APP_EXECUTABLE: process.execPath, NOTALONE_APP_TEST_TOKEN: '', NOTALONE_APP_TEST_LEASE: '' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /app_test_unapproved/);
});

test('App 全量发现排除所有调度安全组，列表结果不代表 App 运行', () => {
  const result = spawnSync(process.execPath, [path.join(desktop, 'node_modules/playwright/cli.js'), 'test', '--list'],
    { cwd: desktop, encoding: 'utf8', timeout: 8000, env: { ...process.env, NOTALONE_APP_TEST_FILES: '' } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /windows.spec.ts/);
  assert.doesNotMatch(result.stdout, /scheduling\//);
});

test('显式文件范围只发现该组，不能因为 CLI 正则匹配扩成全量', () => {
  const result = spawnSync(process.execPath, [path.join(desktop, 'node_modules/playwright/cli.js'), 'test', '--list'],
    { cwd: desktop, encoding: 'utf8', timeout: 8000,
      env: { ...process.env, NOTALONE_APP_TEST_FILES: JSON.stringify(['tests/windows.spec.ts']) } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /windows.spec.ts/);
  assert.doesNotMatch(result.stdout, /backend.spec.ts|contact-restart.spec.ts|scheduling\//);
});
