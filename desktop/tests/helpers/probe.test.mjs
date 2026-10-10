import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { repositoryBuildInvocation } from '../../scripts/prepare-probe.mjs';

test('仓库构建 shell 不执行合成启动配置，配置目录隔离于用户目录', { skip: process.platform !== 'darwin' }, async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-build-shell-'));
  try {
    const script = path.join(owned, 'build-fixture.sh');
    await writeFile(script, 'exit 0\n');
    await writeFile(path.join(owned, '.zshenv'), 'printf synthetic > "$ZDOTDIR/startup-read"\n');
    const invocation = repositoryBuildInvocation(script, owned);
    // red 阶段也只读取自有合成配置；不给旧实现机会访问真实 .zshenv。
    const result = spawnSync(invocation.program, invocation.arguments, { ...invocation.options,
      env: { ...invocation.options.env, ZDOTDIR: owned }, encoding: 'utf8' });
    assert.equal(result.status, 0);
    await assert.rejects(access(path.join(owned, 'startup-read')));
    assert.equal(invocation.options.env.ZDOTDIR, owned);
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('仓库探针公开准备入口仅构建搬运，保存包内默认路径后仍核验核心库', { skip: process.platform !== 'darwin' }, async () => {
  const owned = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-probe-preparation-')));
  try {
    const resources = path.join(owned, 'Resources'); const userData = path.join(owned, 'userData');
    await mkdir(resources); await mkdir(userData);
    const destination = path.join(resources, 'notalone-probe');
    const command = path.resolve('scripts/prepare-probe.mjs');
    const prepared = spawnSync(process.execPath, [command, '--destination', destination], {
      encoding: 'utf8', timeout: 120_000, env: { PATH: '/usr/bin:/bin' },
    });
    assert.equal(prepared.status, 0, '仓库探针构建和静态搬运应通过，不运行产物。');
    const report = JSON.parse(prepared.stdout);
    assert.equal(report.helperExecuted, false); assert.equal(report.nativeAcceptance, false);
    assert.equal(report.state, 'prepared'); assert.equal(report.runtimeKind, 'repository-probe');
    assert.deepEqual((await readdir(destination)).sort(), ['libNotAloneSyncCore.dylib', 'manifest.json', 'notalone-sync-probe']);
    const manifest = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'));
    assert.match(manifest.buildSourceDigest, /^[a-f0-9]{64}$/);
    assert.equal(manifest.sourceDeclaration, `repository:${manifest.buildSourceDigest}`);
    assert.equal(manifest.buildSources.length, 9);
    assert.ok(manifest.buildSources.some((source) => source.name === 'Sources/NotAloneSyncCore/RegionCalibration.swift'));
    assert.equal(manifest.runtimeValidated, false); assert.equal(manifest.provenanceVerified, false);
    assert.ok(!prepared.stdout.includes(owned));
    const occupied = spawnSync(process.execPath, [command, '--destination', destination], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(occupied.status, 2); assert.equal(JSON.parse(occupied.stdout).code, 'helper_prepare_destination');
    const runner = path.join(owned, 'startup.mjs');
    await build({ stdin: { contents: `import { StartupDiagnostics } from './src/main/startup/diagnostics';
import { loadBackendConfiguration, backendEnvironment } from './src/main/backend/config';
const resources = process.argv[2], userData = process.argv[3];
const diagnostics = new StartupDiagnostics(userData, resources);
let paths = await diagnostics.getPaths();
if (process.argv[4] === 'save') {
  await diagnostics.savePaths({ ...paths, pythonExecutable: userData + '/synthetic-python', projectDirectory: userData, envFilePath: userData + '/synthetic.env' }, () => true);
  paths = await diagnostics.getPaths();
}
const config = await loadBackendConfiguration(userData, resources);
config.projectDirectory = userData;
process.stdout.write(JSON.stringify({ paths, probe: backendEnvironment(config, userData).NOTALONE_SYNC_PROBE }));`, resolveDir: process.cwd(), sourcefile: 'probe-startup.ts', loader: 'ts' }, outfile: runner, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const startup = (mode = 'read', extra = {}) => spawnSync(process.execPath, [runner, resources, userData, mode], {
      encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin', NOTALONE_BACKEND_INFO: path.join(userData, 'backend.info'), ...extra },
    });
    const probe = path.join(destination, 'notalone-sync-probe');
    const initial = startup(); assert.equal(initial.status, 0);
    assert.equal(JSON.parse(initial.stdout).paths.syncProbePath, probe);
    assert.equal(JSON.parse(initial.stdout).probe, probe);
    assert.equal(JSON.parse(initial.stdout).paths.wechatCliPath, '');
    const saved = startup('save'); assert.equal(saved.status, 0);
    assert.equal(JSON.parse(saved.stdout).paths.syncProbePath, probe);
    const library = path.join(destination, 'libNotAloneSyncCore.dylib');
    const bytes = await readFile(library);
    await writeFile(library, Buffer.concat([bytes, Buffer.from('synthetic_changed_bytes')]));
    assert.equal(JSON.parse(startup().stdout).paths.syncProbePath, '');
    assert.equal(JSON.parse(startup().stdout).probe, path.join(userData, 'unconfigured-probe'));
    await rm(path.join(userData, 'backend-launch.json'));
    assert.equal(JSON.parse(startup('read', { NOTALONE_SYNC_PROBE: probe }).stdout).paths.syncProbePath, '');
    await writeFile(library, bytes);
    assert.equal(JSON.parse(startup().stdout).paths.syncProbePath, probe);
    await writeFile(path.join(userData, 'backend-launch.json'), JSON.stringify({ syncProbePath: path.join(userData, 'explicit-probe') }));
    assert.equal(JSON.parse(startup().stdout).paths.syncProbePath, path.join(userData, 'explicit-probe'));
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('仓库探针不接受外部输入，重复打包开关在构建前拒绝', { skip: process.platform !== 'darwin' }, () => {
  const outside = spawnSync(process.execPath, [path.resolve('scripts/prepare-probe.mjs'), '--directory', '/notalone-synthetic'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(outside.status, 2); assert.equal(JSON.parse(outside.stdout).code, 'helper_prepare_destination');
  const repeated = spawnSync(process.execPath, [path.resolve('scripts/package.mjs'), '--with-probe', '--with-probe'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(repeated.status, 1); assert.match(repeated.stderr, /helper_check_arguments/);
});
