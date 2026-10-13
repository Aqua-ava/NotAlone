import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';

const libraryKeys = ['WECHAT_CLI_WCDB_LIB', 'WECHAT_CLI_WCDB_DYLIB', 'WX_MCP_WCDB_LIB', 'WX_MCP_WCDB_DYLIB'];

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
import { loadBackendConfiguration, backendEnvironment } from './src/main/backend/config';
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
config.projectDirectory = userData;
const environment = backendEnvironment(config, userData);
process.stdout.write(JSON.stringify({ paths, configuredCli: config.wechatCliPath,
  cli: environment.NOTALONE_WECHAT_CLI,
  libraries: Object.fromEntries(['WECHAT_CLI_WCDB_LIB', 'WECHAT_CLI_WCDB_DYLIB',
    'WX_MCP_WCDB_LIB', 'WX_MCP_WCDB_DYLIB'].map((key) => [key, environment[key]])) }));`,
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

test('未配置外置 CLI 时，旧 App 资源中的 CLI 和 WCDB 不再成为启动默认值', async () => {
  await withStartup(async ({ startup, userData }) => {
    const report = startup();
    assert.equal(report.paths.wechatCliPath, '');
    assert.equal(report.configuredCli, undefined);
    assert.equal(report.cli, path.join(userData, 'unconfigured-cli'));
    assert.deepEqual(report.libraries, {});
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
    assert.equal(initial.cli, environmentCli);
    const saved = startup(environment, 'save');
    assert.equal(saved.paths.wechatCliPath, savedCli);
    assert.equal(saved.configuredCli, savedCli);
    assert.equal(saved.cli, savedCli);
    assert.equal(startup(environment).cli, savedCli);
  });
});

test('调用外置 CLI 时保留用户已有的 WCDB 环境路径，不指定 App 资源中的库', async () => {
  await withStartup(async ({ startup, userData }) => {
    const libraries = Object.fromEntries(libraryKeys.map((key, index) => [key, path.join(userData, `external-library-${index}`)]));
    const report = startup({ NOTALONE_WECHAT_CLI: path.join(userData, 'external-cli'), ...libraries });
    assert.deepEqual(report.libraries, libraries);
  });
});
