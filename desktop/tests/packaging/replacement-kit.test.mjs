import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const prepare = new URL('../../scripts/prepare-replacement-kit.mjs', import.meta.url).pathname;

test('离线工具包拒绝改字节的固定PBS开发输入，且不产生可交付目录', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-kit-test-'));
  try {
    const cache = path.join(owned, 'cache'); await mkdir(cache);
    await writeFile(path.join(cache, 'pbs.tar.gz'), 'synthetic invalid development Python');
    await assert.rejects(run(process.execPath, [prepare, '--source-cache', cache,
      '--licenses-directory', path.join(owned, 'licenses'), '--output-directory', path.join(owned, 'kit')]),
    (error) => /replacement_kit_input_hash:pbs.tar.gz/.test(error.stderr));
    assert.deepEqual(await readdir(owned), ['cache']);
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('复制安装在创建输出前拒绝通过目录别名重叠原App的目标', async () => {
  const { symlink } = await import('node:fs/promises');
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-copy-test-'));
  try {
    const app = path.join(owned, 'Original.app'); await mkdir(app);
    await symlink(app, path.join(owned, 'alias'));
    const install = new URL('../../scripts/install-runtime-copy.mjs', import.meta.url).pathname;
    await assert.rejects(run(process.execPath, [install, '--app-directory', app,
      '--runtime-directory', path.join(owned, 'runtime'), '--output-app', path.join(owned, 'alias', 'Copy.app'),
      '--receipt', path.join(owned, 'receipt.json')]), (error) => /replacement_install_path_overlap/.test(error.stderr));
    assert.deepEqual(await readdir(app), []);
    assert.deepEqual((await readdir(owned)).sort(), ['Original.app', 'alias']);
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('接收者在仓库外验证kit，增改任意携带字节都会失败', async () => {
  const { cp, readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-detached-kit-'));
  try {
    const entry = path.join(owned, 'kit.mjs');
    await cp(new URL('../../scripts/runtime/replacement-kit.mjs', import.meta.url), entry);
    await writeFile(path.join(owned, 'payload.txt'), 'synthetic');
    await writeFile(path.join(owned, 'kit-inventory.json'), JSON.stringify({ formatVersion: 1, files: [
      { path: 'kit.mjs', sha256: createHash('sha256').update(await readFile(entry)).digest('hex'), bytes: (await readFile(entry)).length },
      { path: 'payload.txt', sha256: 'b3cc0475bb78a5026098858e9889acf666d31062d513d303314eca31d36e72f2', bytes: 9 },
    ] }));
    assert.match((await run(process.execPath, [entry, 'check'], { cwd: owned, env: { PATH: '/usr/bin:/bin' } })).stdout, /完整性通过/);
    await writeFile(path.join(owned, 'payload.txt'), 'modified!');
    await assert.rejects(run(process.execPath, [entry, 'check'], { cwd: owned }), (error) => /replacement_kit_inventory_mismatch/.test(error.stderr));
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('复制安装拒绝已有输出并保留原字节', async () => {
  const { readFile } = await import('node:fs/promises');
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-existing-copy-'));
  try {
    const output = path.join(owned, 'Existing.app'); await writeFile(output, 'owned existing output');
    const install = new URL('../../scripts/install-runtime-copy.mjs', import.meta.url).pathname;
    await assert.rejects(run(process.execPath, [install, '--app-directory', path.join(owned, 'Original.app'),
      '--runtime-directory', path.join(owned, 'runtime'), '--output-app', output, '--receipt', path.join(owned, 'receipt.json')]),
    (error) => /replacement_install_output_exists/.test(error.stderr));
    assert.equal(await readFile(output, 'utf8'), 'owned existing output');
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('仓库外复制安装允许包内框架链接，保留原包和ASAR并严格签名', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const { cp, readFile, symlink } = await import('node:fs/promises');
  const { runtimeInventory } = await import('../../scripts/managed-runtime.mjs');
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-signed-copy-'));
  try {
    const app = path.join(owned, 'Original.app'), runtime = path.join(owned, 'modified-runtime');
    await mkdir(path.join(app, 'Contents/MacOS'), { recursive: true });
    const source = path.join(owned, 'main.c'); await writeFile(source, 'int main(void) { return 0; }\n');
    const executable = path.join(app, 'Contents/MacOS/Synthetic');
    await run('/usr/bin/clang', ['-arch', 'arm64', source, '-o', executable]);
    await run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', executable]);
    const paths = ['python/bin/python3.12', ...['initdb', 'postgres', 'pg_isready', 'psql', 'pg_dump', 'pg_restore'].map((name) => `postgres/bin/${name}`),
      ...['server/command.py', 'startup_diagnostics.py', 'startup_database.py', 'managed_postgres.py', 'parent_lifetime.py'].map((name) => `project/backend/src/notalone/${name}`)];
    for (const name of paths) {
      await mkdir(path.dirname(path.join(runtime, name)), { recursive: true });
      if (name.endsWith('.py')) await writeFile(path.join(runtime, name), '# 合成夹具，不执行\n');
      else await cp(executable, path.join(runtime, name));
    }
    const manifest = { formatVersion: 1, architecture: 'arm64', components: ['cpython', 'notalone'].map((name) => ({ name, version: 'synthetic', source: 'repository:synthetic', sha256: '0'.repeat(64) })),
      paths: { python: 'python/bin/python3.12', project: 'project', postgres: 'postgres/bin' }, files: await runtimeInventory(runtime) };
    await writeFile(path.join(runtime, 'manifest.json'), JSON.stringify(manifest));
    await mkdir(path.join(app, 'Contents/Resources')); await cp(runtime, path.join(app, 'Contents/Resources/notalone-runtime'), { recursive: true });
    await writeFile(path.join(app, 'Contents/Resources/app.asar'), 'synthetic ASAR preserved');
    await writeFile(path.join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Synthetic</string><key>CFBundleIdentifier</key><string>test.notalone.synthetic</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
    await symlink('../MacOS', path.join(app, 'Contents/Resources/internal-link'));
    await run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', app]);
    const before = await readFile(executable);
    await symlink(owned, path.join(owned, 'alias'));
    const output = path.join(owned, 'alias/Copy.app'), receipt = path.join(owned, 'receipt.json');
    await run(process.execPath, [new URL('../../scripts/install-runtime-copy.mjs', import.meta.url).pathname,
      '--app-directory', app, '--runtime-directory', runtime, '--output-app', output, '--receipt', receipt]);
    assert.equal(await readFile(path.join(output, 'Contents/Resources/app.asar'), 'utf8'), 'synthetic ASAR preserved');
    assert.deepEqual(await readFile(executable), before);
    assert.equal(JSON.parse(await readFile(receipt, 'utf8')).originalUnchanged, true);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', output]);
  } finally { await rm(owned, { recursive: true, force: true }); }
});
