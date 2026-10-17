import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareFrontendNotices, verifyFrontendNotices, verifyElectronArchive, prepareElectronNotices, verifyElectronNotices } from '../../scripts/distribution-notices.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
test('前端原始通知核对锁与安装版本后保留，缺失或改字节时不产生分发材料', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'notalone-notices-'));
  try {
    const original = 'Copyright synthetic fixture\nOriginal permission text.\n';
    const record = { name: 'react', version: '1.0.0', resolved: 'https://registry.npmjs.org/react/-/react-1.0.0.tgz', integrity: 'sha512-synthetic', member: 'package/LICENSE', output: 'react/LICENSE', sha256: sha256(original), bytes: Buffer.byteLength(original) };
    const lock = { frontend: [record] }; const output = path.join(root, 'dist/licenses/frontend');
    const installed = path.join(root, 'node_modules/react'); await mkdir(installed, { recursive: true });
    await writeFile(path.join(installed, 'package.json'), JSON.stringify({ name: 'react', version: '1.0.0' }));
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/react': record } }));
    await assert.rejects(prepareFrontendNotices({ projectDirectory: root, outputDirectory: output, lock }), /distribution_notice_unavailable/);
    await assert.rejects(access(output));
    await writeFile(path.join(installed, 'LICENSE'), original + 'changed');
    await assert.rejects(prepareFrontendNotices({ projectDirectory: root, outputDirectory: output, lock }), /distribution_notice_changed/);
    await assert.rejects(access(output));
    await writeFile(path.join(installed, 'LICENSE'), original);
    await prepareFrontendNotices({ projectDirectory: root, outputDirectory: output, lock });
    assert.equal(await readFile(path.join(output, 'react/LICENSE'), 'utf8'), original);
    await verifyFrontendNotices({ directory: output, lock });
    await writeFile(path.join(output, 'react/LICENSE'), original + 'changed');
    await assert.rejects(verifyFrontendNotices({ directory: output, lock }), /distribution_notice_changed/);
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/react': { ...record, integrity: 'sha512-changed' } } }));
    await assert.rejects(prepareFrontendNotices({ projectDirectory: root, outputDirectory: path.join(root, 'other'), lock }), /distribution_package_changed/);
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/react': record } }));
    await writeFile(path.join(installed, 'package.json'), JSON.stringify({ name: 'react', version: '2.0.0' }));
    await assert.rejects(prepareFrontendNotices({ projectDirectory: root, outputDirectory: path.join(root, 'other'), lock }), /distribution_package_changed/);
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

test('公开打包入口在Packager解包之前拒绝同名但摘要不同的离线归档', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'notalone-package-archive-'));
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { electron: '44.7.0' } }));
    await writeFile(path.join(root, `electron-v44.7.0-darwin-${process.arch}.zip`), 'synthetic repacked archive');
    const output = path.join(root, 'output');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/package.mjs', import.meta.url)), '--output-directory', output, '--electron-zip-directory', root], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /package_offline_archive_changed/);
    await assert.rejects(access(output));
  } finally { await rm(root, { recursive: true, force: true }); }
});
