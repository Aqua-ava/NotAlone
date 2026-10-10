import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { access, chmod, copyFile, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { build as buildScript } from 'esbuild';

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

async function withRuntime(use, rpaths = ['@executable_path'], absoluteDependency = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-helper-runtime-'));
  const build = (program, values) => {
    const result = spawnSync(program, values, { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, '合成原生夹具静态构建失败。');
  };
  try {
    await writeFile(path.join(directory, 'wcdb.c'), 'int synthetic_wcdb(void) { return 0; }\n');
    const sentinel = path.join(directory, 'executed');
    await writeFile(path.join(directory, 'cli.c'), `#include <stdio.h>\nextern int synthetic_wcdb(void);\nint main(void) { FILE *f = fopen(${JSON.stringify(sentinel)}, "w"); if (f) fclose(f); return synthetic_wcdb(); }\n`);
    const installName = absoluteDependency ? path.join(await realpath(directory), 'libWCDB.dylib') : '@rpath/libWCDB.dylib';
    build('/usr/bin/xcrun', ['clang', '-dynamiclib', path.join(directory, 'wcdb.c'), `-Wl,-install_name,${installName}`, '-o', path.join(directory, 'libWCDB.dylib')]);
    build('/usr/bin/xcrun', ['clang', path.join(directory, 'cli.c'), '-L', directory, '-lWCDB', ...rpaths.map((value) => `-Wl,-rpath,${value}`), '-o', path.join(directory, 'wechat-cli')]);
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
test('RPATH先搜索外部或未知目录时，不因内部副本存在而通过', { skip: process.platform !== 'darwin' }, async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'notalone-helper-search-'));
  try {
    for (const rpath of [outside, '@unknown_runtime/directory']) {
      await withRuntime(async (directory, sentinel) => {
        await copyFile(path.join(directory, 'libWCDB.dylib'), path.join(outside, 'libWCDB.dylib'));
        const result = spawnSync(process.execPath, [command, ...args(directory)], { encoding: 'utf8', timeout: 20_000 });
        assert.equal(result.status, 2);
        assert.equal(JSON.parse(result.stdout).code, 'helper_check_dependency_unresolved');
        assert.doesNotMatch(result.stdout + result.stderr, new RegExp(outside));
        await assert.rejects(access(sentinel));
      }, [rpath, '@executable_path']);
    }
  } finally { await rm(outside, { recursive: true, force: true }); }
});

test('公开准备入口只搬运核查过的CLI和依赖，保留声明且不执行或复制配置', { skip: process.platform !== 'darwin' }, async () => {
  const resources = await mkdtemp(path.join(tmpdir(), 'notalone-helper-resources-'));
  try {
    await withRuntime(async (directory, sentinel) => {
      await writeFile(path.join(directory, 'private.env'), 'synthetic_private_configuration');
      const destination = path.join(resources, 'notalone-helpers');
      const result = spawnSync(process.execPath, [path.resolve('scripts/prepare-helpers.mjs'), ...args(directory), '--destination', destination], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(result.status, 0);
      const report = JSON.parse(result.stdout);
      assert.equal(report.state, 'prepared'); assert.equal(report.helperExecuted, false);
      assert.deepEqual((await readdir(destination)).sort(), ['libWCDB.dylib', 'manifest.json', 'wechat-cli']);
      const manifest = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'));
      assert.equal(manifest.versionDeclaration, 'synthetic-1');
      assert.equal(manifest.provenanceVerified, false); assert.equal(manifest.runtimeValidated, false);
      for (const file of ['wechat-cli', 'libWCDB.dylib']) assert.deepEqual(await readFile(path.join(destination, file)), await readFile(path.join(directory, file)));
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic_private_configuration/);
      assert.ok(!result.stdout.includes(directory) && !result.stdout.includes(destination));
      await assert.rejects(access(sentinel));
    });
  } finally { await rm(resources, { recursive: true, force: true }); }
});

test('搬运后通过公开启动诊断使用包内CLI，变更时停用且显式配置优先', { skip: process.platform !== 'darwin' }, async () => {
  const owned = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-bundled-startup-')));
  try {
    const resources = path.join(owned, 'Resources');
    const userData = path.join(owned, 'userData');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(resources); await mkdir(userData);
    const destination = path.join(resources, 'notalone-helpers');
    await withRuntime(async (directory, sentinel) => {
      const prepare = spawnSync(process.execPath, [path.resolve('scripts/prepare-helpers.mjs'), ...args(directory), '--destination', destination], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(prepare.status, 0);
      await assert.rejects(access(sentinel));
    });
    const runner = path.join(owned, 'startup.mjs');
    await buildScript({ stdin: { contents: `import { StartupDiagnostics } from './src/main/startup/diagnostics';\nimport { loadBackendConfiguration, backendEnvironment } from './src/main/backend/config';\nconst resources = process.argv[2]; const userData = process.argv[3];\nconst paths = await new StartupDiagnostics(userData, resources).getPaths();\nconst config = await loadBackendConfiguration(userData, resources);\nconfig.projectDirectory = userData;\nprocess.stdout.write(JSON.stringify({paths, cli: backendEnvironment(config, userData).NOTALONE_WECHAT_CLI}));`, resolveDir: process.cwd(), sourcefile: 'startup.ts', loader: 'ts' }, outfile: runner, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const startup = (extra = {}) => spawnSync(process.execPath, [runner, resources, userData], { encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin', NOTALONE_BACKEND_INFO: path.join(userData, 'backend.info'), ...extra } });
    const result = startup();
    assert.equal(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.paths.wechatCliPath, path.join(destination, 'wechat-cli'));
    assert.equal(report.cli, path.join(destination, 'wechat-cli'));
    assert.equal(report.paths.syncProbePath, '');
    const cli = path.join(destination, 'wechat-cli');
    const original = await readFile(cli);
    await writeFile(cli, Buffer.concat([original, Buffer.from('synthetic_changed_bytes')]));
    const changed = startup();
    assert.equal(changed.status, 0);
    assert.equal(JSON.parse(changed.stdout).paths.wechatCliPath, '');
    assert.equal(JSON.parse(changed.stdout).cli, path.join(userData, 'unconfigured-cli'));
    await writeFile(cli, original);
    const library = path.join(destination, 'libWCDB.dylib');
    const libraryBytes = await readFile(library); await rm(library);
    assert.equal(JSON.parse(startup().stdout).paths.wechatCliPath, '');
    const outside = path.join(userData, 'outside.dylib'); await writeFile(outside, libraryBytes);
    await symlink(outside, library);
    assert.equal(JSON.parse(startup().stdout).paths.wechatCliPath, '');
    await rm(library); await writeFile(library, libraryBytes);
    const manifestPath = path.join(destination, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, files: [manifest.files[0], manifest.files[0]] }));
    assert.equal(JSON.parse(startup().stdout).paths.wechatCliPath, '');
    await writeFile(manifestPath, JSON.stringify(manifest));
    assert.equal(JSON.parse(startup().stdout).paths.wechatCliPath, cli);
    // 配置经原公开 JSON 文件边界进入，不让测试引入额外的生产加载器。
    await writeFile(path.join(userData, 'backend-launch.json'), JSON.stringify({ wechatCliPath: path.join(userData, 'explicit-cli') }));
    const explicit = startup({ NOTALONE_WECHAT_CLI: path.join(userData, 'environment-cli') });
    assert.equal(explicit.status, 0);
    assert.equal(JSON.parse(explicit.stdout).paths.wechatCliPath, path.join(userData, 'explicit-cli'));
    assert.equal(JSON.parse(explicit.stdout).cli, path.join(userData, 'explicit-cli'));
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('准备入口不覆盖已有目录，依赖使用原绝对路径时拒绝并清理自有半成品', { skip: process.platform !== 'darwin' }, async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-helper-relocation-'));
  try {
    await withRuntime(async (directory, sentinel) => {
      const { mkdir } = await import('node:fs/promises');
      const occupied = path.join(owned, 'existing'); await mkdir(occupied);
      await writeFile(path.join(occupied, 'keep'), 'synthetic_owned_existing');
      const existing = spawnSync(process.execPath, [path.resolve('scripts/prepare-helpers.mjs'), ...args(directory), '--destination', occupied], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(existing.status, 2); assert.equal(JSON.parse(existing.stdout).code, 'helper_prepare_destination');
      assert.equal(await readFile(path.join(occupied, 'keep'), 'utf8'), 'synthetic_owned_existing');
      const destination = path.join(owned, 'notalone-helpers');
      const moved = spawnSync(process.execPath, [path.resolve('scripts/prepare-helpers.mjs'), ...args(directory), '--destination', destination], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(moved.status, 2); assert.equal(JSON.parse(moved.stdout).code, 'helper_check_dependency_unresolved');
      await assert.rejects(access(destination));
      await assert.rejects(access(sentinel));
      assert.ok(!moved.stdout.includes(directory));
    }, ['@executable_path'], true);
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('打包只声明部分helper参数时，在构建图标和打包前拒绝', { skip: process.platform !== 'darwin' }, () => {
  const result = spawnSync(process.execPath, [path.resolve('scripts/package.mjs'), '--helper-version', 'synthetic-1'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /helper_check_arguments/);
});
