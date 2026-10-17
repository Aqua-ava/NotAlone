import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const script = new URL('../../scripts/prepare-wechat.mjs', import.meta.url).pathname;
test('微信组件构建默认离线，缺少固定来源缓存时不联网或留下可用产物', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-wechat-offline-'));
  try {
    const cache = path.join(owned, 'cache'); await mkdir(cache);
    const output = path.join(owned, 'notalone-wechat');
    const result = spawnSync(process.execPath, [script, '--source-cache', cache, '--output-directory', output], { encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /wechat_source_missing/);
    assert.deepEqual(await readdir(owned), ['cache']);
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('固定归档被替换时在构建前失败，不使用开发缓存掩盖错误', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-wechat-source-'));
  try {
    const cache = path.join(owned, 'cache'); await mkdir(cache);
    const lock = JSON.parse(await readFile(new URL('../../wechat-sources.lock.json', import.meta.url), 'utf8'));
    // 预检每个名称存在后，构建器必须核验第一份固定来源的真实摘要。
    for (const item of lock.archives) await writeFile(path.join(cache, item.filename), 'synthetic replaced source');
    const result = spawnSync(process.execPath, [script, '--source-cache', cache, '--output-directory', path.join(owned, 'notalone-wechat')], { encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /wechat_source_hash:go.tar.gz/);
    assert.deepEqual(await readdir(owned), ['cache']);
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('组件清单拒绝文件替换、链接、额外程序和伪造接入验收，来源锁也必须匹配构建约定', async () => {
  const { createHash } = await import('node:crypto');
  const { chmod, symlink } = await import('node:fs/promises');
  const { inspectWechatComponents, wechatAcceptance, wechatCapabilities, wechatInventory, wechatLockedComponents, wechatPaths } = await import('../../scripts/wechat-components.mjs');
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-wechat-integrity-'));
  try {
    const sourceLock = await readFile(new URL('../../wechat-sources.lock.json', import.meta.url));
    const required = [...Object.values(wechatPaths), 'debugger/lib/liblldb.dylib', 'debugger/lib/libpython3.12.dylib', 'licenses/wechat-sources.lock.json', 'licenses/readonly-cli.patch'];
    for (const name of required) { await mkdir(path.dirname(path.join(owned, name)), { recursive: true }); await writeFile(path.join(owned, name), 'synthetic', { mode: 0o700 }); }
    await writeFile(path.join(owned, 'licenses/wechat-sources.lock.json'), sourceLock);
    await writeFile(path.join(owned, 'licenses/readonly-cli.patch'), await readFile(new URL('../../wechat-patches/readonly-cli.patch', import.meta.url)));
    const manifest = { formatVersion: 1, runtimeKind: 'notalone-wechat', architecture: 'arm64', paths: wechatPaths, capabilities: wechatCapabilities, acceptance: { ...wechatAcceptance },
      components: wechatLockedComponents, provenance: { signing: 'ad-hoc-development', developerId: false, notarized: false, sourceLockSha256: createHash('sha256').update(sourceLock).digest('hex') }, files: await wechatInventory(owned) };
    const save = () => writeFile(path.join(owned, 'manifest.json'), JSON.stringify(manifest)); await save(); await inspectWechatComponents(owned);
    const cli = path.join(owned, wechatPaths.cli); await writeFile(cli, 'modified'); await assert.rejects(() => inspectWechatComponents(owned), /wechat_inventory_mismatch/);
    await writeFile(cli, 'synthetic'); await writeFile(path.join(owned, 'bin/wxkey'), 'synthetic'); await assert.rejects(() => inspectWechatComponents(owned), /wechat_forbidden_file/); await rm(path.join(owned, 'bin/wxkey'));
    await rm(cli); await symlink('/bin/sh', cli); await assert.rejects(() => inspectWechatComponents(owned), /wechat_symlink_forbidden/); await rm(cli); await writeFile(cli, 'synthetic', { mode: 0o700 });
    await chmod(cli, 0o600); manifest.files = await wechatInventory(owned); await save(); await assert.rejects(() => inspectWechatComponents(owned), /wechat_component_missing/); await chmod(cli, 0o700);
    manifest.files = await wechatInventory(owned); manifest.acceptance.realWechat = true; await save(); await assert.rejects(() => inspectWechatComponents(owned), /wechat_manifest_invalid/); manifest.acceptance.realWechat = false;
    await writeFile(path.join(owned, 'licenses/wechat-sources.lock.json'), '{}'); manifest.provenance.sourceLockSha256 = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'; manifest.files = await wechatInventory(owned); await save();
    await assert.rejects(() => inspectWechatComponents(owned), /wechat_source_lock_mismatch/);
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('真实研发CLI保留适配器帮助协议且在入口拒绝维护和通用调用', { skip: !process.env.NOTALONE_TEST_WECHAT_COMPONENTS }, async () => {
  const { inspectWechatComponents } = await import('../../scripts/wechat-components.mjs');
  const directory = process.env.NOTALONE_TEST_WECHAT_COMPONENTS;
  const manifest = await inspectWechatComponents(directory);
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-wechat-command-'));
  const environment = { HOME: owned, TMPDIR: owned, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', WECHAT_CLI_STRICT_READ_ONLY: 'false', WECHAT_CLI_DISABLE_AUTO_REFRESH: 'false', WX_KEY_BIN: '/bin/sh' };
  const execute = args => spawnSync(path.join(directory, manifest.paths.cli), args, { cwd: owned, env: environment, encoding: 'utf8', timeout: 10_000 });
  try {
    const version = execute(['--version']); assert.equal(version.status, 0); assert.equal(JSON.parse(version.stdout).data.version, '2.0.1-rc.5');
    for (const args of [['sessions','--help'],['help','resolve-chat'],['tail','--help'],['watch','--help']]) { const result = execute(args); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).ok, true); }
    for (const args of [['keychain','status'],['update'],['bootstrap'],['cache','refresh'],['call-json','sessions','{}'],['asr','setup']]) { const result = execute(args); assert.equal(result.status, 2); assert.match(result.stderr, /notalone_command_disabled/); }
    assert.deepEqual(await readdir(owned), []);
  } finally { await rm(owned, { recursive: true, force: true }); }
});
