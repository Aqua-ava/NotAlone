import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';

async function withStartup(use) {
  const owned = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-external-cli-')));
  try {
    const resources = path.join(owned, 'Resources'); const userData = path.join(owned, 'userData');
    await mkdir(resources); await mkdir(userData);
    const oldRuntime = path.join(resources, 'notalone-helpers'); await mkdir(oldRuntime);
    const architecture = process.arch === 'x64' ? 'x86_64' : process.arch;
    const files = [];
    for (const name of ['wechat-cli', 'libWCDB.dylib']) {
      // 仅构造旧版清单会接受的合成字节；夹具不会被执行或加载。
      const bytes = Buffer.from(`synthetic-${name}-never-executed\n`);
      await writeFile(path.join(oldRuntime, name), bytes, { mode: 0o700 });
      files.push({ name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
        signature: 'verified', architectures: [architecture] });
    }
    await writeFile(path.join(oldRuntime, 'manifest.json'), JSON.stringify({ schemaVersion: 1,
      runtimeKind: 'wechat-cli', architecture, versionDeclaration: 'synthetic-1', provenanceVerified: false,
      runtimeValidated: false, helperExecuted: false, nativeAcceptance: false, files }));
    const runner = path.join(owned, 'startup.mjs');
    await build({ stdin: { contents: `import { StartupDiagnostics } from './src/main/startup/diagnostics';
import { loadBackendConfiguration } from './src/main/backend/config';
const resources = process.argv[2], userData = process.argv[3];
const diagnostics = new StartupDiagnostics(userData, resources);
let paths = await diagnostics.getPaths();
if (process.argv[4] === 'save') {
  await diagnostics.savePaths({ ...paths, pythonExecutable: userData + '/synthetic-python',
    projectDirectory: userData, envFilePath: userData + '/synthetic.env',
    wechatCliPath: userData + '/saved-cli' }, () => true);
  paths = await diagnostics.getPaths();
}
const config = await loadBackendConfiguration(userData, resources);
process.stdout.write(JSON.stringify({ paths, configuredCli: config.wechatCliPath }));`,
      resolveDir: process.cwd(), sourcefile: 'external-cli-startup.ts', loader: 'ts' }, outfile: runner,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const startup = (environment = {}, mode = 'read') => {
      const result = spawnSync(process.execPath, [runner, resources, userData, mode], {
        encoding: 'utf8', timeout: 10_000,
        env: { PATH: '/usr/bin:/bin', NOTALONE_BACKEND_INFO: path.join(userData, 'backend.info'), ...environment },
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    await use({ startup, userData });
  } finally { await rm(owned, { recursive: true, force: true }); }
}

test('未配置外置 CLI 时，旧 App 资源中的 CLI 不再成为启动默认值', async () => {
  await withStartup(async ({ startup }) => {
    const report = startup();
    assert.equal(report.paths.wechatCliPath, '');
    assert.equal(report.configuredCli, undefined);
  });
});

test('用户可选择环境中的外置 CLI，启动设置保存的路径优先并可再次读取', async () => {
  await withStartup(async ({ startup, userData }) => {
    const environmentCli = path.join(userData, 'environment-cli');
    const savedCli = path.join(userData, 'saved-cli');
    const environment = { NOTALONE_WECHAT_CLI: environmentCli };
    const initial = startup(environment);
    assert.equal(initial.paths.wechatCliPath, environmentCli);
    assert.equal(initial.configuredCli, environmentCli);
    const saved = startup(environment, 'save');
    assert.equal(saved.paths.wechatCliPath, savedCli);
    assert.equal(saved.configuredCli, savedCli);
    assert.equal(startup(environment).configuredCli, savedCli);
  });
});
