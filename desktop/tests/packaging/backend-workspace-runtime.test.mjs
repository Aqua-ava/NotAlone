import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {prepareBackendRuntime} from '../../scripts/prepare-backend-runtime.mjs';
import {runtimeInventory} from '../../scripts/managed-runtime.mjs';

const run = promisify(execFile);
test('workspace 后端生产闭包搬离源码后仍解析传递依赖且保留原始身份元数据', {timeout: 120_000}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-workspace-runtime-'));
  const repository = path.join(directory, 'source');
  async function put(name, content) {
    const selected = path.join(repository, name);
    await mkdir(path.dirname(selected), {recursive: true});
    await writeFile(selected, typeof content === 'string' ? content : JSON.stringify(content));
  }
  try {
    await put('package.json', {private: true});
    await put('pnpm-workspace.yaml', 'packages:\n  - backend-ts\n  - packages/*\ninjectWorkspacePackages: true\n');
    const manifest = {name: 'synthetic-backend', version: '1.0.0', type: 'module', files: ['src', 'profile', 'database'],
      dependencies: {'synthetic-direct': 'workspace:*'}, devDependencies: {'synthetic-dev': 'workspace:*'}};
    await put('backend-ts/package.json', manifest);
    await put('backend-ts/src/entry.mjs', "import value from 'synthetic-direct'; console.log(value);\n");
    await put('backend-ts/profile/host.patch.yml', '[]\n');
    await put('backend-ts/database/migrations/001.sql', 'SELECT 1;\n');
    await put('backend-ts/.env', 'SYNTHETIC_SECRET=excluded\n');
    await put('packages/direct/package.json', {name: 'synthetic-direct', version: '1.0.0', main: 'index.cjs', dependencies: {'synthetic-leaf': 'workspace:*'}});
    await put('packages/direct/index.cjs', "module.exports = require('synthetic-leaf');\n");
    await put('packages/leaf/package.json', {name: 'synthetic-leaf', version: '1.0.0', main: 'index.cjs'});
    await put('packages/leaf/index.cjs', "module.exports = 'portable-transitive';\n");
    await put('packages/dev/package.json', {name: 'synthetic-dev', version: '1.0.0'});
    await run('pnpm', ['install', '--offline', '--ignore-scripts'], {cwd: repository});
    const originalLock = await readFile(path.join(repository, 'pnpm-lock.yaml'), 'utf8');
    const originalManifest = await readFile(path.join(repository, 'backend-ts/package.json'), 'utf8');
    const project = path.join(directory, 'project');
    await prepareBackendRuntime({repository, project, workDirectory: path.join(directory, 'staging')});
    await put('backend-ts/package.json', {...manifest, dependencies: {'synthetic-missing': '1.0.0'}});
    await assert.rejects(prepareBackendRuntime({repository, project: path.join(directory, 'stale-project'),
      workDirectory: path.join(directory, 'stale-staging')}), error => /ERR_PNPM_OUTDATED_LOCKFILE/.test(error.stdout));
    assert.equal(await readFile(path.join(repository, 'pnpm-lock.yaml'), 'utf8'), originalLock);
    await put('backend-ts/package.json', manifest);
    await put('pnpm-workspace.yaml', 'packages:\n  - packages/*\ninjectWorkspacePackages: true\n');
    await assert.rejects(prepareBackendRuntime({repository, project: path.join(directory, 'missing-project'),
      workDirectory: path.join(directory, 'missing-staging')}), error => /No projects matched/.test(error.stdout));
    const moved = path.join(directory, 'moved');
    await rename(project, moved);
    await rm(repository, {recursive: true});
    await rm(path.join(directory, 'staging'), {recursive: true});
    const result = await run(process.execPath, [path.join(moved, 'backend-ts/src/entry.mjs')], {cwd: moved});
    assert.equal(result.stdout.trim(), 'portable-transitive');
    assert.equal(await readFile(path.join(moved, 'pnpm-lock.yaml'), 'utf8'), originalLock);
    assert.equal(await readFile(path.join(moved, 'backend-ts/package.json'), 'utf8'), originalManifest);
    const inventory = await runtimeInventory(moved);
    assert.ok(inventory.some(file => file.path.endsWith('synthetic-leaf/index.cjs')));
    assert.equal(inventory.some(file => file.path.includes('synthetic-dev') || file.path.endsWith('/.env')), false);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
