import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { backupConfig, databaseCoverage, mergeMissingKeys, recoverInterrupted, redact, refreshWechatDatabaseKeys, waitForDatabaseOpen, withConfigAside }
  from '../scripts/refresh-wechat-db-keys.mjs';

// 全部使用合成盐与占位密钥，不涉及真实微信资料。
const salt = index => Buffer.alloc(16, index).toString('hex');
const key = index => Buffer.alloc(32, index).toString('hex');

async function fixture(t, { present = [1, 2], databases = { 'message/message_0.db': 1, 'message/message_resource.db': 3 } } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'notalone-key-refresh-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const accountRoot = path.join(home, 'account');
  for (const [name, index] of Object.entries(databases)) {
    const file = path.join(accountRoot, 'db_storage', name);
    await mkdir(path.dirname(file), { recursive: true });
    const page = Buffer.alloc(4096); Buffer.from(salt(index), 'hex').copy(page, 0);
    await writeFile(file, page);
  }
  const config = path.join(home, 'config.json');
  const base = { schema_version: 2, wxid: 'synthetic', db_root: accountRoot, key_epoch: 5, keys: Object.fromEntries(present.map(i => [salt(i), key(i)])) };
  await writeFile(config, JSON.stringify(base), { mode: 0o600 }); await chmod(config, 0o600);
  const wxkey = path.join(home, 'wxkey'), shadowApp = path.join(home, 'Shadow.app');
  await writeFile(wxkey, '#!/bin/sh\n', { mode: 0o700 }); await mkdir(shadowApp);
  return { home, config, base, accountRoot, paths: { config, wxkey, shadowApp } };
}

const quiet = () => { const lines = []; return { lines, say: line => lines.push(line) }; };

test('覆盖检查只报告缺密钥的库名', async t => {
  const f = await fixture(t);
  const coverage = await databaseCoverage(JSON.parse(await readFile(f.config, 'utf8')));
  assert.deepEqual(coverage.covered, ['message/message_0.db']);
  assert.deepEqual(coverage.missing, ['message/message_resource.db']);
});

test('合并只补缺失的盐，保留已有密钥，拒绝账号不符与非法条目', () => {
  const current = { wxid: 'a', db_root: '/r', key_epoch: 5, keys: { [salt(1)]: key(1) }, extra: 'keep' };
  const fresh = { wxid: 'a', db_root: '/r', key_epoch: 9, keys: { [salt(1)]: key(7), [salt(3)]: key(3) } };
  const { merged, added } = mergeMissingKeys(current, fresh);
  assert.equal(added, 1);
  assert.equal(merged.keys[salt(1)], key(1), '已有密钥不被新配置覆盖');
  assert.equal(merged.keys[salt(3)], key(3));
  assert.equal(merged.key_epoch, 9); assert.equal(merged.extra, 'keep');
  assert.throws(() => mergeMissingKeys(current, { ...fresh, wxid: 'b' }), /wechat_key_account_mismatch/);
  assert.throws(() => mergeMissingKeys(current, { ...fresh, keys: { [salt(3)]: 'short' } }), /wechat_key_entry_invalid/);
  assert.throws(() => mergeMissingKeys(current, { ...fresh, keys: { nothex: key(3) } }), /wechat_key_entry_invalid/);
});

test('输出脱敏：长十六进制串与含密钥字段的整行都被去掉', () => {
  const text = `ok ${salt(3)} done\n  "key": "${key(2)}",\nplain line`;
  const out = redact(text);
  assert.ok(!out.includes(salt(3)) && !out.includes(key(2)));
  assert.ok(out.includes('plain line') && out.includes('<已隐藏>'));
});

test('挪开配置：成功时读出新配置并放回旧配置，失败也放回', async t => {
  const f = await fixture(t);
  const original = await readFile(f.config);
  const fresh = await withConfigAside(f.config, async () => {
    assert.equal(existsSync(f.config), false, '任务运行期间真实配置已挪开');
    await writeFile(f.config, JSON.stringify({ ...f.base, keys: { [salt(3)]: key(3) } }), { mode: 0o600 });
  });
  assert.deepEqual(Object.keys(fresh.keys), [salt(3)]);
  assert.ok((await readFile(f.config)).equals(original));
  await assert.rejects(withConfigAside(f.config, async () => { throw new Error('boom'); }), /boom/);
  assert.ok((await readFile(f.config)).equals(original));
  assert.deepEqual((await readdir(f.home)).filter(name => name.includes('aside')), []);
});

test('中断后遗留的挪开文件：无当前配置时自动放回，有当前配置时拒绝', async t => {
  const f = await fixture(t);
  const original = await readFile(f.config);
  const { rename } = await import('node:fs/promises');
  await rename(f.config, `${f.config}.aside-refresh`);
  assert.equal(await recoverInterrupted(f.config), 'restored');
  assert.ok((await readFile(f.config)).equals(original));
  await writeFile(`${f.config}.aside-refresh`, 'x');
  assert.equal(await recoverInterrupted(f.config).catch(error => error.message), 'wechat_key_aside_present');
});

test('备份同日重复运行不覆盖已有备份', async t => {
  const f = await fixture(t);
  const day = new Date('2026-11-05T00:00:00Z');
  const first = await backupConfig(f.config, day), second = await backupConfig(f.config, day);
  assert.notEqual(first, second); assert.ok(existsSync(first) && existsSync(second));
});

test('等待库被打开：检测到、进程退出、超时三种结果', async () => {
  let calls = 0;
  const lsof = async () => (++calls >= 3 ? '... /x/db_storage/message/message_resource.db\n' : '...\n');
  const options = { lsof, sleeper: async () => {}, intervalMs: 1 };
  assert.equal(await waitForDatabaseOpen(1, 'message_resource.db', options), 'open');
  assert.equal(await waitForDatabaseOpen(1, 'message_resource.db', { ...options, alive: () => false }), 'exited');
  let clock = 0;
  assert.equal(await waitForDatabaseOpen(1, 'message_resource.db', { lsof: async () => '', sleeper: async () => { clock += 10; }, now: () => clock, timeoutMs: 25 }), 'timeout');
});

function depsFor(f, over = {}) {
  const out = quiet();
  return { out, deps: { say: out.say, confirm: async () => true, appStopped: async () => true, wechatRunning: async () => false,
    launchShadow: () => 4242, lsof: async () => 'x /db_storage/message/message_resource.db\n', alive: () => true, sleeper: async () => {},
    runWxkey: async () => ({ code: 0, tail: '' }), ...over } };
}

test('--check 只读：缺密钥返回 2，不备份、不启动、不改配置', async t => {
  const f = await fixture(t); const original = await readFile(f.config);
  const { deps } = depsFor(f, { launchShadow: () => assert.fail('不应启动'), runWxkey: () => assert.fail('不应运行') });
  const result = await refreshWechatDatabaseKeys({ check: true, paths: f.paths }, deps);
  assert.equal(result.exitCode, 2);
  assert.ok((await readFile(f.config)).equals(original));
  assert.deepEqual((await readdir(f.home)).filter(name => name.includes('backup')), []);
});

test('目标库已覆盖时无需补取', async t => {
  const f = await fixture(t, { present: [1, 3] });
  const { deps } = depsFor(f, { confirm: () => assert.fail('不应询问') });
  assert.deepEqual(await refreshWechatDatabaseKeys({ paths: f.paths }, deps), { status: 'covered', exitCode: 0 });
});

test('用户未确认时不做任何改动', async t => {
  const f = await fixture(t); const original = await readFile(f.config);
  const { deps } = depsFor(f, { confirm: async () => false, launchShadow: () => assert.fail('不应启动') });
  const result = await refreshWechatDatabaseKeys({ paths: f.paths }, deps);
  assert.equal(result.status, 'declined');
  assert.ok((await readFile(f.config)).equals(original));
  assert.deepEqual((await readdir(f.home)).filter(name => name.includes('backup')), []);
});

test('前置条件：App 或正式微信在运行时拒绝，且尚未改配置', async t => {
  for (const [over, code] of [[{ appStopped: async () => false }, 'wechat_key_app_running'], [{ wechatRunning: async () => true }, 'wechat_key_wechat_running']]) {
    const f = await fixture(t); const original = await readFile(f.config);
    const { deps } = depsFor(f, over);
    await assert.rejects(refreshWechatDatabaseKeys({ paths: f.paths }, deps), new RegExp(code));
    assert.ok((await readFile(f.config)).equals(original));
  }
});

test('完整流程：扫描出新密钥，只合并缺失的盐，旧密钥不变，输出不含任何密钥值', async t => {
  const f = await fixture(t);
  const { deps, out } = depsFor(f, {
    runWxkey: async args => {
      assert.deepEqual(args.slice(0, 2), ['setup', '--pid']); assert.equal(args[2], '4242');
      assert.equal(existsSync(f.config), false, '扫描期间默认配置路径应空出');
      await writeFile(f.config, JSON.stringify({ ...f.base, key_epoch: 8, keys: { [salt(1)]: key(9), [salt(3)]: key(3) } }), { mode: 0o600 });
      return { code: 0, tail: '' };
    },
  });
  const result = await refreshWechatDatabaseKeys({ paths: f.paths, waitMs: 50 }, deps);
  assert.equal(result.status, 'refreshed'); assert.equal(result.added, 1);
  const final = JSON.parse(await readFile(f.config, 'utf8'));
  assert.equal(final.keys[salt(1)], key(1)); assert.equal(final.keys[salt(2)], key(2)); assert.equal(final.keys[salt(3)], key(3));
  assert.equal(final.key_epoch, 8);
  assert.equal(((await import('node:fs')).statSync(f.config).mode & 0o777), 0o600);
  const printed = out.lines.join('\n');
  for (const secret of [key(1), key(2), key(3), key(9), salt(3)]) assert.ok(!printed.includes(secret), '输出不得包含密钥或盐');
  assert.equal((await readdir(f.home)).filter(name => name.includes('backup')).length, 1);
  assert.deepEqual((await readdir(f.home)).filter(name => name.includes('aside') || name.includes('merge')), []);
});

test('扫描失败（没写出新配置）时回滚到原配置并报错', async t => {
  const f = await fixture(t); const original = await readFile(f.config);
  const { deps } = depsFor(f);
  await assert.rejects(refreshWechatDatabaseKeys({ paths: f.paths, waitMs: 50 }, deps), /wechat_key_setup_failed/);
  assert.ok((await readFile(f.config)).equals(original));
});

test('影子微信中途退出或一直没打开目标库时失败，配置不变', async t => {
  for (const [over, code] of [[{ alive: () => false }, 'wechat_key_shadow_exited'], [{ lsof: async () => '' }, 'wechat_key_login_timeout']]) {
    const f = await fixture(t); const original = await readFile(f.config);
    const { deps } = depsFor(f, over);
    await assert.rejects(refreshWechatDatabaseKeys({ paths: f.paths, waitMs: 5 }, deps), new RegExp(code));
    assert.ok((await readFile(f.config)).equals(original));
  }
});

test('扫描后目标库仍缺密钥时报错但保留已合并的其他密钥', async t => {
  const f = await fixture(t);
  const { deps } = depsFor(f, { runWxkey: async () => { await writeFile(f.config, JSON.stringify({ ...f.base, keys: { [salt(4)]: key(4) } }), { mode: 0o600 }); return { code: 0, tail: '' }; } });
  await assert.rejects(refreshWechatDatabaseKeys({ paths: f.paths, waitMs: 50 }, deps), /wechat_key_target_still_missing/);
  assert.equal(JSON.parse(await readFile(f.config, 'utf8')).keys[salt(4)], key(4));
});
