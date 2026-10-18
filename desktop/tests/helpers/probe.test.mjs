import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, chmod, cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { repositoryBuildInvocation } from '../../scripts/prepare-probe.mjs';
import { inspectRuntime } from '../../scripts/probe-runtime.mjs';

test('开发加速源接线使用已验证仓库根，不使用临时Electron应用目录', async () => {
  const entry = await readFile('src/main/index.ts', 'utf8');
  assert.match(entry, /resolveHeaderChangeSourcePath\(resourcesDirectory, development\?\.projectDirectory\)/);
  assert.doesNotMatch(entry, /resolveHeaderChangeSourcePath\([^;]*app\.getAppPath\(/);
});

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

test('仓库探针公开准备入口仅构建搬运，现场隔离配置沿包内默认路径核验核心库', { skip: process.platform !== 'darwin' }, async () => {
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
    assert.deepEqual((await readdir(destination)).sort(), ['libNotAloneSyncCore.dylib', 'manifest.json', 'notalone-header-change-source', 'notalone-sync-probe']);
    const manifest = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'));
    assert.match(manifest.buildSourceDigest, /^[a-f0-9]{64}$/);
    assert.equal(manifest.sourceDeclaration, `repository:${manifest.buildSourceDigest}`);
    assert.equal(manifest.buildSources.length, 18);
    assert.ok(manifest.buildSources.some((source) => source.name === 'Sources/NotAloneSyncCore/RegionCalibration.swift'));
    assert.ok(manifest.buildSources.some((source) => source.name === 'Sources/NotAloneSyncCore/ForegroundStatusPreview.swift'));
    assert.ok(manifest.buildSources.some((source) => source.name === 'Sources/NotAloneSyncCore/HeaderChangeDiagnostics.swift'));
    assert.equal(manifest.runtimeValidated, false); assert.equal(manifest.provenanceVerified, false);
    const helper = path.join(destination, 'notalone-header-change-source');
    const identifiers = Object.fromEntries(manifest.files.filter(file => file.signingIdentifier)
      .map(file => [file.name, file.signingIdentifier]));
    assert.deepEqual(identifiers, { 'notalone-sync-probe': 'com.notalone.sync-probe.cli',
      'notalone-header-change-source': 'com.notalone.sync-probe.header-change' });
    await access(helper, 1);
    assert.ok(!prepared.stdout.includes(owned));
    const occupied = spawnSync(process.execPath, [command, '--destination', destination], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(occupied.status, 2); assert.equal(JSON.parse(occupied.stdout).code, 'helper_prepare_destination');
    const runner = path.join(owned, 'startup.mjs');
    await build({ stdin: { contents: `import { StartupDiagnostics } from './src/main/startup/diagnostics';
import { loadBackendConfiguration, backendEnvironment } from './src/main/backend/config';
import { resolveHeaderChangeSourcePath } from './src/main/backend/bundled-helpers';
const resources = process.env.NOTALONE_SYNTHETIC_NO_RESOURCES === '1' ? undefined : process.argv[2], userData = process.argv[3];
const diagnostics = new StartupDiagnostics(userData, resources);
let paths = await diagnostics.getPaths();
if (process.argv[4] === 'save') {
  await diagnostics.savePaths({ ...paths, pythonExecutable: userData + '/synthetic-python', projectDirectory: userData, envFilePath: userData + '/synthetic.env' }, () => true);
  paths = await diagnostics.getPaths();
}
const config = await loadBackendConfiguration(userData, resources);
config.projectDirectory = userData;
process.stdout.write(JSON.stringify({ paths, probe: backendEnvironment(config, userData).NOTALONE_SYNC_PROBE,
  headerChange: await resolveHeaderChangeSourcePath(resources, process.env.NOTALONE_SYNTHETIC_PROJECT_PATH) }));`, resolveDir: process.cwd(), sourcefile: 'probe-startup.ts', loader: 'ts' }, outfile: runner, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const startup = (mode = 'read', extra = {}) => spawnSync(process.execPath, [runner, resources, userData, mode], {
      encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin', NOTALONE_BACKEND_INFO: path.join(userData, 'backend.info'), ...extra },
    });
    const probe = path.join(destination, 'notalone-sync-probe');
    const initial = startup(); assert.equal(initial.status, 0);
    assert.equal(JSON.parse(initial.stdout).paths.syncProbePath, probe);
    assert.equal(JSON.parse(initial.stdout).probe, probe);
    assert.equal(JSON.parse(initial.stdout).headerChange, helper);
    assert.equal(JSON.parse(initial.stdout).paths.wechatCliPath, '');
    // 新来源必须完整成组，不能以局部源清单通过包内核验。
    const manifestPath = path.join(destination, 'manifest.json');
    const external = startup('read', { NOTALONE_SYNC_PROBE: path.join(userData, 'external-probe') });
    assert.equal(JSON.parse(external.stdout).probe, path.join(userData, 'external-probe'));
    assert.equal(JSON.parse(external.stdout).headerChange, helper, '外部正式probe也只用当前有效包内的独立helper。');
    const unbundled = startup('read', { NOTALONE_SYNC_PROBE: path.join(userData, 'external-probe'), NOTALONE_SYNTHETIC_NO_RESOURCES: '1' });
    assert.equal(JSON.parse(unbundled.stdout).headerChange, undefined, '无有效包时不查外部probe的兄弟文件。');

    const developmentApp = path.join(owned, 'desktop');
    const developmentResources = path.join(developmentApp, '.dev', 'resources');
    await mkdir(developmentResources, { recursive: true });
    await cp(destination, path.join(developmentResources, 'notalone-probe'), { recursive: true });
    const developmentEnvironment = { NOTALONE_SYNTHETIC_NO_RESOURCES: '1', NOTALONE_SYNTHETIC_PROJECT_PATH: owned };
    assert.equal(JSON.parse(startup('read', developmentEnvironment).stdout).headerChange,
      path.join(developmentResources, 'notalone-probe', 'notalone-header-change-source'), '开发版只从固定.dev/resources整组校验辅助源。');
    assert.equal(JSON.parse(startup('read', { NOTALONE_SYNTHETIC_PROJECT_PATH: owned }).stdout).headerChange,
      helper, '正式资源优先，不能使用开发副本。');
    await writeFile(path.join(developmentResources, 'notalone-probe', 'notalone-header-change-source'), 'invalid');
    assert.equal(JSON.parse(startup('read', developmentEnvironment).stdout).headerChange,
      undefined, '开发副本字节不匹配时停用，不绕过完整性核验。');

    const helperBytes = await readFile(helper);
    await chmod(helper, 0o644);
    assert.equal(JSON.parse(startup().stdout).paths.syncProbePath, '');
    assert.equal(JSON.parse(startup().stdout).headerChange, undefined, 'helper没有X位时整组停用。');
    await chmod(helper, 0o755);
    await rm(helper);
    assert.equal(JSON.parse(startup().stdout).paths.syncProbePath, '');
    assert.equal(JSON.parse(startup().stdout).headerChange, undefined, '清单声明的helper缺失时不得回退短probe。');
    await writeFile(helper, helperBytes, { mode: 0o755 });

    const wrongDeclaration = structuredClone(manifest);
    wrongDeclaration.files.find(file => file.name === 'notalone-header-change-source').signingIdentifier = 'com.notalone.sync-probe.cli';
    await writeFile(manifestPath, JSON.stringify(wrongDeclaration));
    assert.equal(JSON.parse(startup().stdout).headerChange, undefined, '清单中的helper身份必须明确独立。');
    await writeFile(manifestPath, JSON.stringify(manifest));

    // 即使清单摘要同步更新并自报独立身份，也不能把同一签名的短probe冒充持续源。
    const probeBytes = await readFile(probe);
    await writeFile(helper, probeBytes);
    const sameIdentity = structuredClone(manifest);
    Object.assign(sameIdentity.files.find(file => file.name === 'notalone-header-change-source'), {
      sha256: createHash('sha256').update(probeBytes).digest('hex'), bytes: probeBytes.length,
    });
    await writeFile(manifestPath, JSON.stringify(sameIdentity));
    assert.equal(JSON.parse(startup().stdout).headerChange, undefined);
    await assert.rejects(inspectRuntime({ directory: destination, runtimeKind: 'repository-probe',
      arch: manifest.architecture, version: manifest.versionDeclaration }), /helper_check_signature/);
    await writeFile(helper, helperBytes);
    await writeFile(manifestPath, JSON.stringify(manifest));
    assert.equal(JSON.parse(startup().stdout).headerChange, helper);

    const oldFiles = structuredClone(manifest);
    oldFiles.files = oldFiles.files.filter(file => file.name !== 'notalone-header-change-source');
    for (const file of oldFiles.files) delete file.signingIdentifier;
    await writeFile(manifestPath, JSON.stringify(oldFiles));
    const oldReport = JSON.parse(startup().stdout);
    assert.equal(oldReport.paths.syncProbePath, probe, '旧两文件包仍可执行正式观察。');
    assert.equal(oldReport.headerChange, undefined, '未声明的兄弟文件不能成为辅助源，绝不复用正式probe。');
    await writeFile(manifestPath, JSON.stringify(manifest));

    const incomplete = structuredClone(manifest);
    incomplete.buildSources = incomplete.buildSources.filter((source) => !source.name.endsWith('/HeaderChangeGeometry.swift'));
    incomplete.buildSourceDigest = createHash('sha256').update(JSON.stringify(incomplete.buildSources)).digest('hex');
    incomplete.sourceDeclaration = `repository:${incomplete.buildSourceDigest}`;
    await writeFile(manifestPath, JSON.stringify(incomplete));
    assert.equal(JSON.parse(startup().stdout).paths.syncProbePath, '');
    const orphan = structuredClone(manifest);
    orphan.buildSources = orphan.buildSources.filter((source) => !/\/HeaderChange(Detector|Geometry|Source)\.swift$/.test(source.name));
    orphan.buildSourceDigest = createHash('sha256').update(JSON.stringify(orphan.buildSources)).digest('hex');
    orphan.sourceDeclaration = `repository:${orphan.buildSourceDigest}`;
    await writeFile(manifestPath, JSON.stringify(orphan));
    assert.equal(JSON.parse(startup().stdout).paths.syncProbePath, '', '诊断文件不能脱离完整变化源组单独通过。');
    const unknown = structuredClone(manifest);
    unknown.buildSources.find((source) => source.name.endsWith('/HeaderChangeDiagnostics.swift')).name = 'Sources/NotAloneSyncCore/UnknownDiagnostics.swift';
    unknown.buildSourceDigest = createHash('sha256').update(JSON.stringify(unknown.buildSources)).digest('hex');
    unknown.sourceDeclaration = `repository:${unknown.buildSourceDigest}`;
    await writeFile(manifestPath, JSON.stringify(unknown));
    assert.equal(JSON.parse(startup().stdout).paths.syncProbePath, '', '18项总数不能绕过来源名白名单。');
    const legacy = structuredClone(manifest);
    legacy.buildSources = legacy.buildSources.filter((source) => !source.name.endsWith('/HeaderChangeDiagnostics.swift'));
    legacy.buildSourceDigest = createHash('sha256').update(JSON.stringify(legacy.buildSources)).digest('hex');
    legacy.sourceDeclaration = `repository:${legacy.buildSourceDigest}`;
    await writeFile(manifestPath, JSON.stringify(legacy));
    assert.equal(JSON.parse(startup().stdout).paths.syncProbePath, probe, '原17源完整包仍沿既有校验读取。');
    await writeFile(manifestPath, JSON.stringify(manifest));
    // 加载实际现场用例的选项，替换测试注册器，绝不执行用例或启动App。
    const layoutConfiguration = path.join(owned, 'layout-configuration.mjs');
    await build({ stdin: { contents: `import './tests/native-foreground-layout.spec';
import { isolatedAppEnvironment } from './tests/isolated-environment';
const environment = isolatedAppEnvironment(process.argv[2], globalThis.layoutOptions.appEnvironment);
process.stdout.write(JSON.stringify({ NOTALONE_SYNC_PROBE: environment.NOTALONE_SYNC_PROBE,
  NOTALONE_WECHAT_CLI: environment.NOTALONE_WECHAT_CLI }));`, resolveDir: process.cwd(), sourcefile: 'layout-configuration.ts', loader: 'ts' },
    outfile: layoutConfiguration, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{
      name: '仅登记现场测试选项', setup(builder) {
        builder.onResolve({ filter: /^(\.\/app-fixture|@playwright\/test)$/ }, ({ path: request }) => ({ path: request, namespace: 'layout-test-registration' }));
        builder.onLoad({ filter: /.*/, namespace: 'layout-test-registration' }, ({ path: request }) => ({ contents: request === './app-fixture'
          ? `export const test = Object.assign(() => {}, { skip() {}, use(options) { globalThis.layoutOptions = options; } });
export function selectMenu() { throw new Error('本检查禁止运行App用例'); }`
          : `export function expect() { throw new Error('本检查禁止执行App断言'); }`, loader: 'js' }));
      },
    }] });
    const layoutEnvironment = (packaged) => {
      const result = spawnSync(process.execPath, [layoutConfiguration, userData], { encoding: 'utf8', timeout: 10_000,
        env: { PATH: '/usr/bin:/bin', ...(packaged ? { NOTALONE_TEST_APP_EXECUTABLE: '/synthetic-host' } : {}) } });
      assert.equal(result.status, 0); return JSON.parse(result.stdout);
    };
    assert.equal(layoutEnvironment(false).NOTALONE_SYNC_PROBE, path.resolve('../native/macos/build/cli/notalone-sync-probe'));
    const packagedEnvironment = layoutEnvironment(true);
    assert.equal(JSON.parse(startup('read', packagedEnvironment).stdout).paths.syncProbePath, probe,
      '签名现场用例的有效隔离环境必须选择Resources探针，不能落入unavailable-probe。');
    assert.equal(packagedEnvironment.NOTALONE_WECHAT_CLI, path.join(userData, 'unavailable-cli'));
    const saved = startup('save'); assert.equal(saved.status, 0);
    assert.equal(JSON.parse(saved.stdout).paths.syncProbePath, probe);
    const library = path.join(destination, 'libNotAloneSyncCore.dylib');
    const bytes = await readFile(library);
    await writeFile(library, Buffer.concat([bytes, Buffer.from('synthetic_changed_bytes')]));
    assert.equal(JSON.parse(startup().stdout).paths.syncProbePath, '');
    assert.equal(JSON.parse(startup().stdout).probe, path.join(userData, 'unconfigured-probe'));
    assert.equal(JSON.parse(startup('read', packagedEnvironment).stdout).paths.syncProbePath, '');
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
