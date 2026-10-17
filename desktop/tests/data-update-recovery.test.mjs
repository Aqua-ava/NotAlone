import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { requiredRuntimeFiles } from '../managed-runtime-contract.mjs';

const execute = promisify(execFile);
const subject = await build({ entryPoints: ['src/main/startup/data-update.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function controller(directory, resources) {
  const module = path.join(directory, 'subject.mjs');
  await writeFile(module, subject.outputFiles[0].text);
  const { LocalDataUpdates } = await import(module);
  return new LocalDataUpdates(directory, resources, { getLifetimeLock() {} }, {});
}
async function until(probe) {
  const deadline = Date.now() + 3000;
  while (!await probe()) {
    if (Date.now() >= deadline) throw Error('合成更新命令未在限定时间到达边界');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('私有更新收据是无写端FIFO时公开恢复失败，退出不会等待文件写端', { timeout: 5000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-update-receipt-'));
  try {
    await execute('mkfifo', ['-m', '600', path.join(directory, 'update-operation.json')]);
    const updates = await controller(directory);
    assert.equal(await updates.recoverInterruptedSwitch(), false);
    assert.equal(updates.getState().phase, 'failed');
    assert.equal(updates.getState().canContinue, false);
    assert.equal(updates.isRecoveryBlocked(), true);
    await updates.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('并发公开重检仅启动一次命令，退出有界回收忽略TERM的本次进程组', { timeout: 12_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-update-stop-'));
  const resources = path.join(directory, 'resources'), root = path.join(resources, 'notalone-runtime');
  const marker = path.join(directory, 'owned-processes');
  let updates;
  let pids = [];
  try {
    const files = [];
    for (const relative of requiredRuntimeFiles) {
      const filename = path.join(root, relative); await mkdir(path.dirname(filename), { recursive: true });
      const text = relative === 'python/bin/python3.12' ? `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');
process.on('SIGTERM',()=>{});
fs.appendFileSync(${JSON.stringify(marker)},process.pid+'\\n');
cp.spawn(process.execPath,['-e',"const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.appendFileSync("+JSON.stringify(${JSON.stringify(marker)})+",process.pid+'\\\\n');setInterval(()=>{},1000)"],{stdio:'ignore'});
setInterval(()=>{},1000);\n` : '# 合成组件，仅核验库存，不执行\n';
      await writeFile(filename, text, { mode: 0o700 });
      files.push({ path: relative, sha256: createHash('sha256').update(text).digest('hex'), executable: !relative.endsWith('.py') });
    }
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ formatVersion: 1, architecture: process.arch,
      components: ['python', 'postgres'].map(name => ({ name, version: 'synthetic', source: 'repository:test', sha256: 'a'.repeat(64) })),
      paths: { python: 'python/bin/python3.12', project: 'project', postgres: 'postgres/bin' }, files }));
    const env = path.join(directory, 'legacy.env'); await writeFile(env, '# 合成配置\n', { mode: 0o600 });
    await writeFile(path.join(directory, 'backend-launch.json'), JSON.stringify({ envFilePath: env }));
    updates = await controller(directory, resources);
    const first = updates.refresh(), duplicate = updates.refresh();
    await until(async () => { pids = (await readFile(marker, 'utf8').catch(() => '')).trim().split(/\s+/).map(Number).filter(pid => pid > 1); return pids.length >= 2; });
    assert.equal(pids.length, 2);
    const started = Date.now();
    await updates.stop(); await Promise.all([first, duplicate]);
    assert.ok(Date.now() - started < 6000);
    await until(() => pids.every(pid => !alive(pid)));
  } finally {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* 仅本用例收据记录的子进程。 */ } }
    await updates?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
