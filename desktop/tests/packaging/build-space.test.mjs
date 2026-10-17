import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, statfs, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { requireBuildSpace } from '../../scripts/build-space.mjs';

const GiB = 1024n ** 3n;
const space = (bytes) => ({ bavail: bytes / 4096n, bsize: 4096n });

test('构建检查每个写入位置，临时卷空间不足时停止', async () => {
  const checked = [];
  await assert.rejects(requireBuildSpace(['/output', '/temporary'], async (directory) => {
    checked.push(directory);
    return space(directory === '/output' ? 30n * GiB : 4n * GiB);
  }), { code: 'build_disk_space_low' });
  assert.deepEqual(checked, ['/output', '/temporary']);
});

test('可用空间达到 15 GiB 时允许构建，不把保留块计入可用空间', async () => {
  await requireBuildSpace(['/output'], async () => space(15n * GiB));
  await assert.rejects(requireBuildSpace(['/output'], async () => ({
    ...space(GiB), bfree: 40n * GiB / 4096n,
  })), { code: 'build_disk_space_low' });
});

test('无法核验空间时停止，不跳过检查继续创建文件', async () => {
  await assert.rejects(requireBuildSpace(['/output'], async () => {
    throw Object.assign(new Error('synthetic_unavailable'), { code: 'EACCES' });
  }), { code: 'build_disk_space_unavailable' });
});

test('实际临时目录使用系统提供的可用空间执行同一检查', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-build-space-'));
  try {
    const value = await statfs(owned, { bigint: true });
    if (value.bavail * value.bsize >= 15n * GiB) await requireBuildSpace([owned]);
    else await assert.rejects(requireBuildSpace([owned]), { code: 'build_disk_space_low' });
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('新目录核验已有祖先，软链接核验目标，失效软链接停止', async () => {
  const owned = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-build-space-paths-')));
  try {
    await requireBuildSpace([path.join(owned, 'new/nested')], async (directory) => {
      await statfs(directory);
      return space(30n * GiB);
    });
    assert.deepEqual(await readdir(owned), []);
    const remote = path.join(owned, 'remote');
    await mkdir(remote);
    const output = path.join(owned, 'out');
    await symlink(remote, output, 'dir');
    await assert.rejects(requireBuildSpace([output], async (directory) => {
      return space(await realpath(directory) === remote ? GiB : 30n * GiB);
    }), { code: 'build_disk_space_low' });
    await symlink(path.join(owned, 'missing'), path.join(owned, 'broken'), 'dir');
    await assert.rejects(requireBuildSpace([path.join(owned, 'broken/nested')]), {
      code: 'build_disk_space_unavailable',
    });
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('真实打包和探针准备入口在空间不足时不留下输出或临时目录', {
  skip: process.platform !== 'darwin',
}, async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-build-space-command-'));
  try {
    const temporary = path.join(owned, 'temporary');
    await mkdir(temporary);
    // 只替换操作系统的空间读数；执行真实 CLI，核对文件系统副作用。
    const preload = `import fs from 'node:fs/promises';
      fs.statfs = async () => ({ bavail: 1024n, bsize: 4096n });`;
    const loader = `data:text/javascript,${encodeURIComponent(preload)}`;
    for (const [script, args] of [
      ['build.mjs', []],
      ['package.mjs', ['--output-directory', path.join(owned, 'package')]],
      ['prepare-probe.mjs', ['--destination', path.join(owned, 'probe')]],
    ]) {
      const command = fileURLToPath(new URL(`../../scripts/${script}`, import.meta.url));
      const result = spawnSync(process.execPath, ['--import', loader, command, ...args], {
        cwd: owned, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, TMPDIR: temporary },
      });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /build_disk_space_low|15 GiB/);
      assert.deepEqual(await readdir(owned), ['temporary']);
      assert.deepEqual(await readdir(temporary), []);
    }
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('公开 npm 打包入口在空间不足时连前置编译产物也不创建', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-build-space-npm-'));
  try {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    await writeFile(path.join(owned, 'package.json'), JSON.stringify({ scripts: manifest.scripts }));
    await symlink(fileURLToPath(new URL('../../scripts', import.meta.url)), path.join(owned, 'scripts'), 'dir');
    for (const name of ['main', 'preload', 'renderer']) await mkdir(path.join(owned, 'src', name), { recursive: true });
    for (const name of ['main', 'preload']) await writeFile(path.join(owned, 'src', name, 'index.ts'), 'export const synthetic = true;');
    await writeFile(path.join(owned, 'src/renderer/index.html'), '<html><title>synthetic</title></html>');
    const preload = `import fs from 'node:fs/promises'; fs.statfs = async () => ({ bavail: 1024n, bsize: 4096n });`;
    const result = spawnSync('npm', ['run', 'package'], { cwd: owned, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(preload)}` },
    });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /15 GiB/);
    assert.deepEqual((await readdir(owned)).sort(), ['package.json', 'scripts', 'src']);
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('默认 out 在其他卷或在线缓存卷不足时，真实打包入口在写入前停止', {
  skip: process.platform !== 'darwin',
}, async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-build-space-volumes-'));
  try {
    const command = fileURLToPath(new URL('../../scripts/package.mjs', import.meta.url));
    for (const target of ['out', 'electron']) {
      const preload = `import fs from 'node:fs/promises'; import path from 'node:path';
        fs.statfs = async (directory) => ({ bavail: path.basename(directory) === ${JSON.stringify(target)} ? 1n : 20n * 1024n ** 3n, bsize: 1n });`;
      const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, command], {
        cwd: owned, encoding: 'utf8', timeout: 10_000,
      });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /15 GiB/);
      assert.deepEqual(await readdir(owned), []);
    }
  } finally { await rm(owned, { recursive: true, force: true }); }
});
