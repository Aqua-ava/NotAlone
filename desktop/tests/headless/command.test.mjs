import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { leasePath } from '../../scripts/app-test-lease.mjs';

const command = path.resolve('scripts/test-pages.mjs');
test('页面入口公开状态明确不启动 Electron', () => {
  const result = spawnSync(process.execPath, [command, '--status'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"state":"absent"/);
  assert.match(result.stdout, /Electron 未运行/);
});
for (const args of [[], ['--case', 'all', '--timeout-seconds', '2'], ['--case', 'memory-reading', '--timeout-seconds', '301'], ['--case', 'memory-reading', '--case', 'memory-reading', '--timeout-seconds', '1']]) {
  test(`拒绝未限定或无效范围：${JSON.stringify(args)}`, () => {
    const result = spawnSync(process.execPath, [command, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2); assert.match(result.stderr, /page_test_arguments/);
  });
}
function start(args, file = command, extraEnvironment = {}) {
  const child = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnvironment } });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  const done = new Promise((resolve) => child.once('close', (code) => resolve({ code, output })));
  const ready = async () => {
    const deadline = Date.now() + 5000;
    while (!output.includes('page_test_probe_ready')) {
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error(output || '探针未就绪。');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { child, done, ready };
}
const probe = (id, hold = 0, timeout = 5) => ['--probe', id, '--hold-ms', String(hold), '--timeout-seconds', String(timeout)];
test('两份独立命令和不同TMPDIR互斥，正常退出后重获租约', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-page-command-'));
  for (const file of ['scripts/test-pages.mjs', 'scripts/app-test-lease.mjs', 'scripts/test-environment.mjs', 'tests/headless/probe-child.mjs']) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true }); await copyFile(path.resolve(file), path.join(directory, file));
  }
  const { symlink } = await import('node:fs/promises');
  await symlink(path.resolve('node_modules'), path.join(directory, 'node_modules'));
  const id = randomUUID(); const running = start(probe(id, 700));
  try {
    await running.ready();
    const second = await start(probe(id), path.join(directory, 'scripts/test-pages.mjs'), { TMPDIR: directory }).done;
    assert.equal(second.code, 2); assert.match(second.output, /app_test_locked/);
    assert.equal((await running.done).code, 0);
    assert.equal((await start(probe(id), path.join(directory, 'scripts/test-pages.mjs')).done).code, 0);
  } finally { if (running.child.exitCode === null) running.child.kill('SIGTERM'); await running.done; await rm(directory, { recursive: true, force: true }); }
});
test('截止时间停止自有合成孩子并正常解除租约', async () => {
  const id = randomUUID(); const result = await start(probe(id, 5000, 1)).done;
  assert.equal(result.code, 124, result.output);
  assert.equal((await start(probe(id)).done).code, 0);
});
for (const [signal, expected] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`${signal} 回收自有孩子并保留正确退出码`, async () => {
    const id = randomUUID(); const running = start(probe(id, 5000));
    await running.ready(); running.child.kill(signal);
    const result = await running.done;
    assert.equal(result.code, expected, result.output);
    assert.equal((await start(probe(id)).done).code, 0);
  });
}
test('不确定收尾保锁，拒绝下一轮；仅本轮记录核验后由测试清理', async () => {
  const id = randomUUID(); const directory = leasePath(id, 'headless');
  const owned = start([...probe(id), '--unconfirmed']);
  let ownedRecord;
  try {
    const failed = await owned.done;
    ownedRecord = JSON.parse(await readFile(path.join(directory, 'lease.json'), 'utf8'));
    assert.equal(ownedRecord.runnerPid, owned.child.pid);
    assert.equal(failed.code, 2); assert.match(failed.output, /page_test_cleanup_unconfirmed/);
    const second = await start(probe(id)).done;
    assert.equal(second.code, 2); assert.match(second.output, /app_test_locked/);
    const record = JSON.parse(await readFile(path.join(directory, 'lease.json'), 'utf8'));
    assert.equal(record.mode, 'headless'); assert.equal(record.coordinator, 'page-checks');
  } finally {
    await owned.done;
    const current = JSON.parse(await readFile(path.join(directory, 'lease.json'), 'utf8'));
    assert.equal(current.runnerPid, owned.child.pid); assert.equal(current.id, ownedRecord?.id);
    await rm(directory, { recursive: true });
  }
});
