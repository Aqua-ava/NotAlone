import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, access, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyDevelopmentProcesses, requireDevelopmentOnly } from '../scripts/development-policy.mjs';

test('只复用当前项目及用户目录的开发宿主，不把测试、其他项目或renderer当作开发实例', () => {
  const lines = [
    '9 1 node scripts/dev.mjs',
    '10 9 /repo/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /repo/desktop/.dev/app --notalone-dev',
    '11 9 /other/Electron.app/Contents/MacOS/Electron /other/.dev/app --notalone-dev',
    '12 9 /repo/Electron.app/Contents/MacOS/Electron /repo/desktop/.dev/app --notalone-dev --user-data-dir=/tmp/test',
    '13 9 /repo/Electron.app/Contents/MacOS/Electron -r /loader /repo/desktop --user-data-dir=/tmp/playwright',
    '14 9 /repo/Electron.app/Contents/Frameworks/Electron Helper --type=renderer',
  ].join('\n');
  assert.deepEqual(classifyDevelopmentProcesses(lines, '/repo/desktop'), { development: [10], packaged: [], orphaned: [] });
  assert.deepEqual(classifyDevelopmentProcesses(lines, '/repo/desktop', '/tmp/test').development, [12]);
});

test('已有打包宿主或多个开发宿主时拒绝继续，单个开发实例可复用', () => {
  const state = classifyDevelopmentProcesses('20 1 /Applications/NotAlone.app/Contents/MacOS/NotAlone', '/repo/desktop');
  assert.throws(() => requireDevelopmentOnly(state), /正常退出/);
  assert.throws(() => requireDevelopmentOnly({ development: [1, 2], packaged: [] }), /多个开发实例/);
  assert.doesNotThrow(() => requireDevelopmentOnly({ development: [1], packaged: [] }));
});

test('直接打包与打包验收入口在创建输出前拒绝，不接受环境开关', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'notalone-release-policy-'));
  try {
    const output = path.join(temporary, 'output');
    for (const args of [['scripts/package.mjs', '--output-directory', output], ['scripts/release-check.mjs']]) {
      const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000,
        env: { ...process.env, NOTALONE_ALLOW_PACKAGE: '1', CI: 'true' } });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /打包入口已锁定/);
      await assert.rejects(access(output));
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('常用启动入口都走开发模式，打包不在门禁前预先构建', async () => {
  const { scripts } = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(scripts.start, 'npm run dev');
  assert.equal(scripts.package, 'node scripts/package.mjs');
  assert.equal(scripts['test:package'], 'node scripts/release-check.mjs');
});

test('孤立宿主不算热更新可用，首次编译阶段也只允许一个监督器', async () => {
  const orphan = classifyDevelopmentProcesses('10 1 /repo/Electron.app/Contents/MacOS/Electron /repo/desktop/.dev/app --notalone-dev', '/repo/desktop');
  assert.throws(() => requireDevelopmentOnly(orphan), /监督器已退出/);
  const { acquireDevelopmentLease } = await import('../scripts/development-lease.mjs');
  const project = await mkdtemp(path.join(tmpdir(), 'notalone-dev-lease-'));
  let first, next;
  try {
    first = await acquireDevelopmentLease(project);
    assert.ok(first);
    assert.equal(await acquireDevelopmentLease(project), undefined);
    await first.close(); first = undefined;
    next = await acquireDevelopmentLease(project);
    assert.ok(next);
  } finally { await first?.close(); await next?.close(); await rm(project, { recursive: true, force: true }); }
});
