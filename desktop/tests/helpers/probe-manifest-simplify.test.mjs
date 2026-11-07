import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { build } from 'esbuild';
import { prepareRepositoryProbe } from '../../scripts/prepare-probe.mjs';

const desktopRoot = process.cwd();

// 用一次真实 prepare 产物做基线，逐案复制到独立 temp，防启动侧按资源目录记忆的核验结果串扰。
test('仓库构建清单校验只按摘要自一致与 sha256 格式判定，不按源文件名、个数或组合规则', { skip: process.platform !== 'darwin' }, async () => {
  const owned = await realpath(await mkdtemp(path.join(os.tmpdir(), 'notalone-probe-manifest-')));
  try {
    await mkdir(path.join(owned, 'Resources'));
    await mkdir(path.join(owned, 'prepared'));
    const destination = path.join(owned, 'prepared', 'notalone-probe');
    await prepareRepositoryProbe(destination);
    const manifestText = await readFile(path.join(destination, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestText);
    assert.match(manifest.buildSourceDigest, /^[a-f0-9]{64}$/);
    assert.equal(manifest.sourceDeclaration, `repository:${manifest.buildSourceDigest}`);
    const recompute = (sources) => createHash('sha256').update(JSON.stringify(sources)).digest('hex');

    const runner = path.join(owned, 'probe-validate-runner.mjs');
    await build({ stdin: { contents: `import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveSyncProbePath, testCodesignExecutor } from './src/main/backend/bundled-helpers';
const execute = promisify(execFile);
const identifiers = { 'notalone-sync-probe': 'com.notalone.sync-probe.cli',
  'notalone-header-change-source': 'com.notalone.sync-probe.header-change' } as const;
testCodesignExecutor((((_program, args) => {
  const target = String(args.at(-1)).split('/').pop() as keyof typeof identifiers;
  return Promise.resolve({ stdout: '', stderr: 'Identifier=' + identifiers[target] });
}) as unknown as typeof execute));
const [resources, mode = 'bundled', external = ''] = process.argv.slice(2);
const configured = mode === 'default-config' ? path.join(resources, 'notalone-probe', 'notalone-sync-probe')
  : mode === 'external' ? external : undefined;
const result = await resolveSyncProbePath(resources, configured);
process.stdout.write(JSON.stringify({ path: result ?? '' }));`,
      resolveDir: desktopRoot, sourcefile: 'probe-manifest-runner.ts', loader: 'ts' }, outfile: runner, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });

    // 逐案复制整棵 notalone-probe；runner 每次新起进程，校验缓存按目录记忆不跨进程。
    const stage = async (mode) => {
      const resources = path.join(await realpath(await mkdtemp(path.join(owned, 'case-'))), 'Resources');
      const root = path.join(resources, 'notalone-probe');
      await mkdir(resources);
      await cp(destination, root, { recursive: true });
      if (mode) {
        const current = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
        await mode(current);
        await writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(current)}\n`);
      }
      return { resources, root, run: async (runnerMode = 'bundled', external = '') => spawnSync(process.execPath, [runner, resources, runnerMode, external],
        { encoding: 'utf8', timeout: 30_000, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } }).stdout };
    };
    const passes = async (label, mode, runnerMode = 'bundled', external = '') => {
      const staged = await stage(mode);
      assert.equal(JSON.parse(await staged.run(runnerMode, external)).path, path.join(staged.root, 'notalone-sync-probe'), label);
    };
    const rejects = async (label, mode) => {
      const staged = await stage(mode);
      assert.equal(JSON.parse(await staged.run()).path, '', label);
    };

    await passes('真实 prepare 产物清单通过核验');
    await passes('包内默认配置路径仍经整组核验后返回探针', null, 'default-config');
    {
      const staged = await stage(null);
      assert.equal(JSON.parse(await staged.run('external', '/b1-outside-probe')).path, '/b1-outside-probe',
        '资源外的配置探针路径按原样透传，不触发包内核验');
    }

    // 新行为：布局不再受源文件名白名单、允许个数或组合规则限制，只要求清单摘要自一致。
    await passes('删除组合规则成员 RegionCalibration 后清单仍通过', (manifest) => {
      manifest.buildSources = manifest.buildSources.filter((source) => source.name !== 'Sources/NotAloneSyncCore/RegionCalibration.swift');
      manifest.buildSourceDigest = recompute(manifest.buildSources);
      manifest.sourceDeclaration = `repository:${manifest.buildSourceDigest}`;
    });
    await passes('白名单外新增 Swift 源文件后清单仍通过', (manifest) => {
      manifest.buildSources.push({ name: 'Sources/NotAloneSyncCore/B1CoinNewSource.swift', sha256: manifest.buildSources[0].sha256 });
      manifest.buildSourceDigest = recompute(manifest.buildSources);
      manifest.sourceDeclaration = `repository:${manifest.buildSourceDigest}`;
    });
    await passes('源文件改名后清单仍通过', (manifest) => {
      manifest.buildSources = manifest.buildSources.map((source) => source.name === 'Sources/NotAloneSyncCLI/main.swift'
        ? { name: 'Sources/NotAloneSyncCLI/source-renamed.swift', sha256: source.sha256 } : source);
      manifest.buildSourceDigest = recompute(manifest.buildSources);
      manifest.sourceDeclaration = `repository:${manifest.buildSourceDigest}`;
    });

    // 原有行为不变：摘要/格式破坏仍拒绝。
    const decoy = createHash('sha256').update('B1-tamper-decoy').digest('hex');
    await rejects('摘要被改且声明同改为错值时仍拒绝', (manifest) => {
      manifest.buildSourceDigest = decoy;
      manifest.sourceDeclaration = `repository:${decoy}`;
    });
    await rejects('单个 buildSource sha256 格式非法时仍拒绝', (manifest) => {
      manifest.buildSources[0] = { name: manifest.buildSources[0].name, sha256: 'gg' };
      manifest.buildSourceDigest = recompute(manifest.buildSources);
      manifest.sourceDeclaration = `repository:${manifest.buildSourceDigest}`;
    });
    await rejects('buildSourceDigest 格式非法时仍拒绝', (manifest) => {
      manifest.buildSourceDigest = 'B1-invalid-digest';
      manifest.sourceDeclaration = `repository:B1-invalid-digest`;
    });
  } finally { await rm(owned, { recursive: true, force: true }); }
});
