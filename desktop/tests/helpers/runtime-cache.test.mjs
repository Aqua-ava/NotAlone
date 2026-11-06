// A3：启动期 helper 核验在同一次启动进程内按资源目录记忆；成功与失败都只执行一次 codesign。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { resolveSyncProbePath, resolveHeaderChangeSourcePath, testCodesignExecutor } from '../../src/main/backend/bundled-helpers.ts';

const identifierFor = (file) => file === 'notalone-header-change-source'
  ? 'com.notalone.sync-probe.header-change' : 'com.notalone.sync-probe.cli';

async function prepare(t) {
  const owned = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-runtime-cache-')));
  t.after(() => rm(owned, { recursive: true, force: true }));
  const destination = path.join(owned, 'Resources', 'notalone-probe');
  await mkdir(path.dirname(destination));
  const prepared = spawnSync(process.execPath, [path.resolve('scripts/prepare-probe.mjs'), '--destination', destination],
    { encoding: 'utf8', timeout: 120_000, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(prepared.status, 0, `仓库探针搬运应成功：${prepared.stdout}\n${prepared.stderr}`);
  return owned;
}

test('同一资源目录两次解析只执行一次 codesign，两次结果一致（注入 execute）', { skip: process.platform !== 'darwin' }, async t => {
  const resources = await realpath(path.join(await prepare(t), 'Resources'));
  let codesignCalls = 0;
  testCodesignExecutor(async (file, args) => {
    codesignCalls += 1;
    if (args.includes('--display')) {
      const target = args.at(-1);
      return { stdout: '', stderr: `Identifier=${identifierFor(path.basename(target))}\n` };
    }
    return { stdout: '', stderr: '' };
  });
  try {
    const first = await resolveSyncProbePath(resources);
    assert.equal(first, path.join(resources, 'notalone-probe', 'notalone-sync-probe'));
    assert.equal(codesignCalls, 4, '两个可执行文件各 verify+display，共 4 次调用');
    const second = await resolveSyncProbePath(resources);
    assert.equal(second, first);
    assert.equal(codesignCalls, 4, '第二次解析复用同一次核验结果，不再执行 codesign');
    const header = await resolveHeaderChangeSourcePath(resources);
    assert.equal(header, path.join(resources, 'notalone-probe', 'notalone-header-change-source'));
    assert.equal(codesignCalls, 4, 'header-change 入口同样复用同一次核验');
  } finally { testCodesignExecutor(undefined); }
});

test('失败结果同样记忆：codesign 失败时两次解析只执行一次，均停用', { skip: process.platform !== 'darwin' }, async t => {
  const resources = await realpath(path.join(await prepare(t), 'Resources'));
  let codesignCalls = 0;
  testCodesignExecutor(async () => { codesignCalls += 1; throw new Error('synthetic codesign failure'); });
  try {
    assert.equal(await resolveSyncProbePath(resources), undefined);
    assert.equal(await resolveSyncProbePath(resources), undefined);
    assert.equal(codesignCalls, 1, '失败核验结果被记忆，第二次解析零 codesign');
  } finally { testCodesignExecutor(undefined); }
});
