import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { prepareFrontendNotices, verifyFrontendNotices, verifyElectronArchive, prepareElectronNotices, verifyElectronNotices } from '../../scripts/distribution-notices.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function frontendLock(record) {
  return {
    lockfileVersion: '9.0',
    importers: { desktop: { dependencies: { [record.name]: { specifier: record.version, version: record.version } } } },
    packages: { [`${record.name}@${record.version}`]: { resolution: { tarball: record.resolved, integrity: record.integrity } } },
    snapshots: { [`${record.name}@${record.version}`]: {} },
  };
}
const writeFrontendLock = (root, value) => writeFile(path.join(root, 'pnpm-lock.yaml'), stringify(value));
test('前端原始通知核对锁与安装版本后保留，缺失或改字节时不产生分发材料', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'notalone-notices-'));
  try {
    const original = 'Copyright synthetic fixture\nOriginal permission text.\n';
    const record = { name: 'react', version: '1.0.0', resolved: 'https://registry.npmjs.org/react/-/react-1.0.0.tgz', integrity: 'sha512-synthetic', member: 'package/LICENSE', output: 'react/LICENSE', sha256: sha256(original), bytes: Buffer.byteLength(original) };
    const lock = { frontend: [record] }; const output = path.join(root, 'dist/licenses/frontend');
    const projectDirectory = path.join(root, 'desktop');
    const installed = path.join(projectDirectory, 'node_modules/react'); await mkdir(installed, { recursive: true });
    await writeFile(path.join(installed, 'package.json'), JSON.stringify({ name: 'react', version: '1.0.0' }));
    await writeFrontendLock(root, frontendLock(record));
    await assert.rejects(prepareFrontendNotices({ projectDirectory, outputDirectory: output, lock }), /distribution_notice_unavailable/);
    await assert.rejects(access(output));
    await writeFile(path.join(installed, 'LICENSE'), original + 'changed');
    await assert.rejects(prepareFrontendNotices({ projectDirectory, outputDirectory: output, lock }), /distribution_notice_changed/);
    await assert.rejects(access(output));
    await writeFile(path.join(installed, 'LICENSE'), original);
    await prepareFrontendNotices({ projectDirectory, outputDirectory: output, lock });
    assert.equal(await readFile(path.join(output, 'react/LICENSE'), 'utf8'), original);
    await verifyFrontendNotices({ directory: output, lock });
    await writeFile(path.join(output, 'react/LICENSE'), original + 'changed');
    await assert.rejects(verifyFrontendNotices({ directory: output, lock }), /distribution_notice_changed/);
    await writeFrontendLock(root, frontendLock({ ...record, integrity: 'sha512-changed' }));
    await assert.rejects(prepareFrontendNotices({ projectDirectory, outputDirectory: path.join(root, 'other'), lock }), /distribution_package_changed/);
    await writeFrontendLock(root, frontendLock({ ...record, resolved: 'https://example.invalid/react.tgz' }));
    await assert.rejects(prepareFrontendNotices({ projectDirectory, outputDirectory: path.join(root, 'other'), lock }), /distribution_package_changed/);
    const changedImporter = frontendLock(record);
    changedImporter.importers.desktop.dependencies.react.version = '2.0.0';
    await writeFrontendLock(root, changedImporter);
    await assert.rejects(prepareFrontendNotices({ projectDirectory, outputDirectory: path.join(root, 'other'), lock }), /distribution_package_changed/);
    await writeFrontendLock(root, frontendLock(record));
    await writeFile(path.join(installed, 'package.json'), JSON.stringify({ name: 'react', version: '2.0.0' }));
    await assert.rejects(prepareFrontendNotices({ projectDirectory, outputDirectory: path.join(root, 'other'), lock }), /distribution_package_changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('前端许可通过 workspace 依赖链读取 pnpm 隔离的传递依赖并核对锁定版本', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'notalone-pnpm-notices-'));
  try {
    const original = 'Synthetic scheduler permission text.\n';
    const record = { name: 'scheduler', version: '1.0.0', resolved: 'https://registry.npmjs.org/scheduler/-/scheduler-1.0.0.tgz', integrity: 'sha512-synthetic', member: 'package/LICENSE', output: 'scheduler/LICENSE', sha256: sha256(original), bytes: Buffer.byteLength(original) };
    const lock = { frontend: [record] }; const projectDirectory = path.join(root, 'desktop');
    const virtualModules = path.join(root, 'node_modules/.pnpm/react-dom@1.0.0/node_modules');
    const reactDom = path.join(virtualModules, 'react-dom');
    const scheduler = path.join(root, 'node_modules/.pnpm/scheduler@1.0.0/node_modules/scheduler');
    await mkdir(path.join(projectDirectory, 'node_modules'), { recursive: true });
    await mkdir(reactDom, { recursive: true }); await mkdir(scheduler, { recursive: true });
    await writeFile(path.join(reactDom, 'package.json'), JSON.stringify({ name: 'react-dom', version: '1.0.0', dependencies: { scheduler: '1.0.0' } }));
    await writeFile(path.join(scheduler, 'package.json'), JSON.stringify({ name: 'scheduler', version: '1.0.0' }));
    await writeFile(path.join(scheduler, 'LICENSE'), original);
    await symlink(reactDom, path.join(projectDirectory, 'node_modules/react-dom'));
    await symlink(scheduler, path.join(virtualModules, 'scheduler'));
    const workspaceLock = frontendLock(record);
    workspaceLock.importers.desktop.dependencies = { 'react-dom': { specifier: '1.0.0', version: '1.0.0(react@1.0.0)' } };
    workspaceLock.snapshots['react-dom@1.0.0(react@1.0.0)'] = { dependencies: { scheduler: '1.0.0' } };
    await writeFrontendLock(root, workspaceLock);
    await assert.rejects(access(path.join(projectDirectory, 'node_modules/scheduler')));
    const output = path.join(root, 'licenses');
    await prepareFrontendNotices({ projectDirectory, outputDirectory: output, lock });
    assert.equal(await readFile(path.join(output, 'scheduler/LICENSE'), 'utf8'), original);
    workspaceLock.snapshots['react-dom@1.0.0(react@1.0.0)'].dependencies.scheduler = '2.0.0';
    await writeFrontendLock(root, workspaceLock);
    await assert.rejects(prepareFrontendNotices({ projectDirectory, outputDirectory: path.join(root, 'other'), lock }), /distribution_package_changed/);
    delete workspaceLock.snapshots['react-dom@1.0.0(react@1.0.0)'].dependencies.scheduler;
    await writeFrontendLock(root, workspaceLock);
    await assert.rejects(prepareFrontendNotices({ projectDirectory, outputDirectory: path.join(root, 'other'), lock }), /distribution_package_changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('离线Electron只接受固定官方归档，原始两份许可复制后继续逐字节校验', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'notalone-electron-notices-'));
  try {
    const archive = 'synthetic official archive'; const name = 'electron-v1.0.0-darwin-arm64.zip';
    const notices = ['LICENSE', 'LICENSES.chromium.html'].map((member) => ({ member, output: member, sha256: sha256(member), bytes: Buffer.byteLength(member) }));
    const lock = { electron: { version: '1.0.0', archives: [{ arch: 'arm64', name, sha256: sha256(archive) }], notices } };
    await writeFile(path.join(root, name), archive + 'repacked');
    await assert.rejects(verifyElectronArchive({ directory: root, version: '1.0.0', arch: 'arm64', lock }), /package_offline_archive_changed/);
    await writeFile(path.join(root, name), archive);
    await verifyElectronArchive({ directory: root, version: '1.0.0', arch: 'arm64', lock });
    const output = path.join(root, 'resources/licenses/electron');
    await assert.rejects(prepareElectronNotices({ extractedDirectory: root, outputDirectory: output, version: '1.0.0', lock }), /distribution_notice_unavailable/);
    await assert.rejects(access(output));
    for (const notice of notices) await writeFile(path.join(root, notice.member), notice.member);
    await prepareElectronNotices({ extractedDirectory: root, outputDirectory: output, version: '1.0.0', lock });
    await verifyElectronNotices({ directory: output, version: '1.0.0', lock });
    await writeFile(path.join(output, 'LICENSE'), 'changed');
    await assert.rejects(verifyElectronNotices({ directory: output, version: '1.0.0', lock }), /distribution_notice_changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('公开打包入口在归档读取和解包之前被发布门禁拒绝', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'notalone-package-archive-'));
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { electron: '44.7.0' } }));
    await writeFile(path.join(root, `electron-v44.7.0-darwin-${process.arch}.zip`), 'synthetic repacked archive');
    const output = path.join(root, 'output');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/package.mjs', import.meta.url)), '--output-directory', output, '--electron-zip-directory', root], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /打包入口已锁定/);
    await assert.rejects(access(output));
  } finally { await rm(root, { recursive: true, force: true }); }
});
