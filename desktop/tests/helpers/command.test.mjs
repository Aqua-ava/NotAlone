import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { access, chmod, copyFile, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const command = path.resolve('scripts/check-helpers.mjs');
const args = (directory) => ['--directory', directory, '--version', 'synthetic-1', '--source', 'https://example.org/synthetic-helper'];
test('没有明确运行时目录和版本来源时，静态核查拒绝且不执行helper', () => {
  const result = spawnSync(process.execPath, [command], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).code, 'helper_check_arguments');
});
test('脚本冒充CLI时拒绝格式，不运行输入文件或泄露路径与内容', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-helper-check-'));
  const sentinel = path.join(directory, 'executed');
  try {
    await writeFile(path.join(directory, 'wechat-cli'), `#!/bin/sh\ntouch '${sentinel}'\n# synthetic_private_text\n`);
    await chmod(path.join(directory, 'wechat-cli'), 0o700);
    await writeFile(path.join(directory, 'libWCDB.dylib'), 'synthetic_private_text');
    const result = spawnSync(process.execPath, [command, ...args(directory)], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).code, 'helper_check_not_macho');
    assert.equal(JSON.parse(result.stdout).helperExecuted, false);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${directory}|synthetic_private_text`));
    await assert.rejects(access(sentinel));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function withRuntime(use) {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-helper-runtime-'));
  const build = (program, values) => {
    const result = spawnSync(program, values, { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, '合成原生夹具静态构建失败。');
  };
  try {
    await writeFile(path.join(directory, 'wcdb.c'), 'int synthetic_wcdb(void) { return 0; }\n');
    const sentinel = path.join(directory, 'executed');
    await writeFile(path.join(directory, 'cli.c'), `#include <stdio.h>\nextern int synthetic_wcdb(void);\nint main(void) { FILE *f = fopen(${JSON.stringify(sentinel)}, "w"); if (f) fclose(f); return synthetic_wcdb(); }\n`);
    build('/usr/bin/xcrun', ['clang', '-dynamiclib', path.join(directory, 'wcdb.c'), '-Wl,-install_name,@rpath/libWCDB.dylib', '-o', path.join(directory, 'libWCDB.dylib')]);
    build('/usr/bin/xcrun', ['clang', path.join(directory, 'cli.c'), '-L', directory, '-lWCDB', '-Wl,-rpath,@executable_path', '-o', path.join(directory, 'wechat-cli')]);
    for (const name of ['wechat-cli', 'libWCDB.dylib']) build('/usr/bin/codesign', ['--force', '--sign', '-', path.join(directory, name)]);
    await use(directory, sentinel);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
test('完整合成运行时通过架构签名和依赖静态检查，但不宣称运行验收', { skip: process.platform !== 'darwin' }, async () => {
  await withRuntime(async (directory, sentinel) => {
    const result = spawnSync(process.execPath, [command, ...args(directory)], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.state, 'static_checks_passed');
    assert.equal(report.runtimeValidated, false); assert.equal(report.provenanceVerified, false);
    assert.equal(report.helperExecuted, false); assert.equal(report.nativeAcceptance, false);
    assert.deepEqual(report.files.map((file) => file.name).sort(), ['libWCDB.dylib', 'wechat-cli']);
    for (const file of report.files) assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(directory));
    await assert.rejects(access(sentinel));
  });
});
test('缺依赖、越界链接、错误架构和损坏签名分别拒绝，错误不回显输入', { skip: process.platform !== 'darwin' }, async () => {
  await withRuntime(async (directory, sentinel) => {
    const check = (values, code) => {
      const result = spawnSync(process.execPath, [command, ...values], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 2);
      assert.equal(JSON.parse(result.stdout).code, code);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(directory));
    };
    check([...args(directory), '--arch', process.arch === 'arm64' ? 'x86_64' : 'arm64'], 'helper_check_architecture');
    const library = path.join(directory, 'libWCDB.dylib');
    const original = path.join(directory, 'original.dylib');
    await rename(library, original);
    check(args(directory), 'helper_check_dependency_unresolved');
    const outside = await mkdtemp(path.join(tmpdir(), 'notalone-helper-outside-'));
    try {
      await copyFile(original, path.join(outside, 'libWCDB.dylib'));
      await symlink(path.join(outside, 'libWCDB.dylib'), library);
      check(args(directory), 'helper_check_dependency_unresolved');
      await rm(library); await rename(original, library);
      const removed = spawnSync('/usr/bin/codesign', ['--remove-signature', library], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(removed.status, 0);
      check(args(directory), 'helper_check_signature');
      await assert.rejects(access(sentinel));
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});
test('来源带认证或查询、相对目录及重复参数在读取前拒绝', () => {
  for (const values of [
    ['--directory', '/notalone-synthetic', '--version', '1', '--source', 'https://user:synthetic@invalid.example/runtime'],
    ['--directory', '/notalone-synthetic', '--version', '1', '--source', 'https://invalid.example/runtime?key=synthetic'],
    ['--directory', 'relative', '--version', '1', '--source', 'https://example.org/runtime'],
    [...args('/notalone-synthetic'), '--version', '2'],
  ]) {
    const result = spawnSync(process.execPath, [command, ...values], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).code, 'helper_check_arguments');
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic@|key=|relative/);
  }
});
test('动态库改名为wechat-cli不能当作可执行运行时通过', { skip: process.platform !== 'darwin' }, async () => {
  await withRuntime(async (directory) => {
    await copyFile(path.join(directory, 'libWCDB.dylib'), path.join(directory, 'wechat-cli'));
    const result = spawnSync(process.execPath, [command, ...args(directory)], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).code, 'helper_check_binary_type');
  });
});
