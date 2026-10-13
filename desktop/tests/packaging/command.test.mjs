import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { access, copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { build as buildScript } from 'esbuild';

test('离线临时打包仅附带自研探针，外置CLI配置与探针签名保持且从不执行产物', { skip: process.platform !== 'darwin' }, async () => {
  const owned = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-package-check-')));
  try {
    const project = process.cwd(); const fixture = path.join(owned, 'fixture');
    const zipDirectory = path.join(owned, 'electron-zip'); const output = path.join(owned, 'output');
    const buildTemporary = path.join(owned, 'build-temporary');
    await mkdir(fixture); await mkdir(zipDirectory);
    await mkdir(buildTemporary); await mkdir(path.join(buildTemporary, 'keep-existing'));
    await writeFile(path.join(buildTemporary, 'keep-existing/sentinel'), 'synthetic_existing_temporary');
    await cp(path.join(project, 'dist'), path.join(fixture, 'dist'), { recursive: true });
    await mkdir(path.join(fixture, 'src/renderer/assets'), { recursive: true });
    await copyFile(path.join(project, 'src/renderer/assets/logo.png'), path.join(fixture, 'src/renderer/assets/logo.png'));
    const packageJson = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
    const version = (await readFile(path.join(project, 'node_modules/electron/dist/version'), 'utf8')).trim();
    assert.equal(version, packageJson.devDependencies.electron);
    await writeFile(path.join(fixture, 'package.json'), JSON.stringify(packageJson));
    const zip = spawnSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', path.join(project, 'node_modules/electron/dist'),
      path.join(zipDirectory, `electron-v${version}-darwin-${process.arch}.zip`)], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(zip.status, 0, '只从已安装Electron生成本轮离线归档。');
    const values = [path.join(project, 'scripts/package.mjs'), '--output-directory', output, '--electron-zip-directory', zipDirectory,
      '--with-probe'];
    const packaged = spawnSync(process.execPath, values, { cwd: fixture, encoding: 'utf8', timeout: 180_000,
      env: { PATH: '/usr/bin:/bin', TMPDIR: buildTemporary } });
    assert.equal(packaged.status, 0, `离线检查包构建应通过：${packaged.stderr.slice(-1200)}`);
    assert.match(packaged.stdout, /ad-hoc 签名校验/);
    assert.equal((await readdir(buildTemporary)).filter((name) => name !== 'keep-existing').length, 0,
      '打包返回后应清理本轮临时文件，不能只依赖测试夹具的最终清理。');
    assert.equal(await readFile(path.join(buildTemporary, 'keep-existing/sentinel'), 'utf8'), 'synthetic_existing_temporary');
    const app = path.join(output, `NotAlone-darwin-${process.arch}/NotAlone.app`);
    const resources = path.join(app, 'Contents/Resources');
    const appEntitlements = spawnSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', app], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(appEntitlements.status, 0);
    const entitlementJson = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'],
      { input: appEntitlements.stdout, encoding: 'utf8', timeout: 10_000 });
    assert.equal(entitlementJson.status, 0);
    assert.deepEqual(JSON.parse(entitlementJson.stdout), { 'com.apple.security.cs.allow-jit': true });
    for (const name of ['notalone-helpers', 'notalone-third-party']) await assert.rejects(access(path.join(resources, name)));
    const packagedFiles = await readdir(resources, { recursive: true });
    assert.ok(packagedFiles.every((file) => !['wechat-cli', 'libWCDB.dylib'].includes(path.basename(file))));
    for (const group of ['notalone-probe']) {
      const manifest = JSON.parse(await readFile(path.join(resources, group, 'manifest.json'), 'utf8'));
      for (const file of manifest.files) {
        const selected = path.join(resources, group, file.name);
        assert.equal(createHash('sha256').update(await readFile(selected)).digest('hex'), file.sha256);
        const signature = spawnSync('/usr/bin/codesign', ['--verify', '--strict', selected], { encoding: 'utf8', timeout: 10_000 });
        assert.equal(signature.status, 0);
        const entitlements = spawnSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', selected], { encoding: 'utf8', timeout: 10_000 });
        assert.doesNotMatch(entitlements.stdout + entitlements.stderr, /com\.apple\.security\.cs\.allow-jit/);
      }
    }
    const userData = path.join(owned, 'userData'); await mkdir(userData);
    const runner = path.join(owned, 'startup.mjs');
    await buildScript({ stdin: { contents: `import { StartupDiagnostics } from './src/main/startup/diagnostics';
import { loadBackendConfiguration, backendEnvironment } from './src/main/backend/config';
const resources = process.argv[2], userData = process.argv[3];
const paths = await new StartupDiagnostics(userData, resources).getPaths();
const config = await loadBackendConfiguration(userData, resources); config.projectDirectory = userData;
process.stdout.write(JSON.stringify({ paths, environment: backendEnvironment(config, userData) }));`, resolveDir: project, sourcefile: 'package-startup.ts', loader: 'ts' }, outfile: runner, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const startup = spawnSync(process.execPath, [runner, resources, userData], { encoding: 'utf8', timeout: 10_000,
      env: { PATH: '/usr/bin:/bin', NOTALONE_BACKEND_INFO: path.join(userData, 'backend.info') } });
    assert.equal(startup.status, 0);
    const result = JSON.parse(startup.stdout);
    assert.equal(result.paths.wechatCliPath, '');
    assert.equal(result.paths.syncProbePath, path.join(resources, 'notalone-probe/notalone-sync-probe'));
    assert.equal(result.environment.NOTALONE_WECHAT_CLI, path.join(userData, 'unconfigured-cli'));
    assert.equal(result.environment.NOTALONE_SYNC_PROBE, result.paths.syncProbePath);
    const keep = path.join(output, 'keep'); await writeFile(keep, 'synthetic_existing_output');
    const occupied = spawnSync(process.execPath, values, { cwd: fixture, encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(occupied.status, 0);
    assert.match(occupied.stderr, /package_output_exists/);
    assert.equal(await readFile(keep, 'utf8'), 'synthetic_existing_output');
    await access(app);
    const missingZip = path.join(owned, 'empty-zip'); const failedOutput = path.join(owned, 'failed-output');
    await mkdir(missingZip);
    const unavailable = spawnSync(process.execPath, values.map((value) => value === output ? failedOutput : value === zipDirectory ? missingZip : value),
      { cwd: fixture, encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin', TMPDIR: owned } });
    assert.notEqual(unavailable.status, 0); assert.match(unavailable.stderr, /package_offline_archive_unavailable/);
    await assert.rejects(access(failedOutput));
  } finally { await rm(owned, { recursive: true, force: true }); }
});
