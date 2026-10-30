import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { QuarantineVault } from '../src/history/quarantine-vault.ts';
import { verifyQuarantineIdentity } from '../src/history/quarantine-identity.ts';
import { runQuarantineCli } from '../src/history/quarantine-cli.ts';

const original = { accountKey: 'account-a', conversationKey: 'friend-a', sourceGeneration: 'generation-a' };
const digest = identity => createHash('sha256').update(JSON.stringify([identity.accountKey, identity.conversationKey, identity.sourceGeneration])).digest('hex');

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'notalone-quarantine-identity-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  const vault = await QuarantineVault.create(root, { scopeDigest: digest(original), displayName: '合成联系人' });
  vault.begin({ expectedPartitions: ['part-a'] });
  vault.appendPage([{ kind: 'text', text: '仅用于身份复核测试的合成正文', status: '99', originalType: '1', sender: 'unknown', sentAt: null,
    partition: 'part-a', table: 'messages-a', localId: '1', serverId: null }]);
  vault.complete({ scopeDigest: digest(original), completedPartitions: ['part-a'], sourceContinuity: 'held', snapshotComplete: true });
  vault.close();
  return { root };
}

function client({ account = original, scope = original, resolveError, accountError, status = 'verified', closeError } = {}) {
  const events = { closed: false, pages: 0 };
  return {
    events,
    accountMetadata: async () => {
      if (accountError) throw new Error(accountError);
      return { status, accountKey: account.accountKey, sourceGeneration: account.sourceGeneration };
    },
    resolveSelected: async displayName => {
      events.displayName = displayName;
      if (resolveError) throw new Error(resolveError);
      return { ...scope, displayName };
    },
    inspectSelected: async () => { throw new Error('must_not_inspect'); },
    quarantineTargetSelected: async () => { throw new Error('must_not_read_target'); },
    quarantinePageSelected: async () => { events.pages++; throw new Error('must_not_read_page'); },
    close: async () => { events.closed = true; if (closeError) throw new Error(closeError); },
  };
}

test('同账号、会话和代次匹配时只报告metadata匹配，正文仍未核验且不调用分页', async t => {
  const { root } = await fixture(t);
  const source = client();
  assert.deepEqual(await verifyQuarantineIdentity(source, root), {
    identity: 'matched', normalHistory: false, stateAssurance: 'unverified', continuity: 'not_verified_across_restarts',
  });
  assert.equal(source.events.displayName, '合成联系人');
  assert.equal(source.events.pages, 0);
  assert.equal(source.events.closed, true);

  const vault = await QuarantineVault.open(root);
  try {
    const records = vault.list({ limit: 10 }).records;
    assert.equal(records.length, 1);
    assert.equal(records[0].state, 'unverified');
    assert.equal(records[0].text, '仅用于身份复核测试的合成正文');
    assert.equal(vault.summary().normalHistory, false);
  } finally { vault.close(); }
});

test('同名联系人但账号、会话或来源代次不同均无法关联', async t => {
  const { root } = await fixture(t);
  const variants = [
    { accountKey: 'account-b', conversationKey: original.conversationKey, sourceGeneration: original.sourceGeneration },
    { ...original, conversationKey: 'friend-b' },
    { ...original, sourceGeneration: 'generation-b' },
  ];
  for (const changed of variants) {
    const source = client({ account: changed, scope: changed });
    await assert.rejects(verifyQuarantineIdentity(source, root), error => error.code === 'identity_unverified' && error.message === 'identity_unverified');
    assert.equal(source.events.displayName, '合成联系人');
    assert.equal(source.events.pages, 0);
    assert.equal(source.events.closed, true);
  }
});

test('复核运行中的隔离仓不改状态、权限或正文，仍可继续追加', async t => {
  const base = await mkdtemp(join(tmpdir(), 'notalone-quarantine-identity-running-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'vault');
  const vault = await QuarantineVault.create(root, { scopeDigest: digest(original), displayName: '合成联系人' });
  t.after(() => vault.close());
  vault.begin({ expectedPartitions: ['part-a'] });
  const first = { kind: 'text', text: '运行中保留的合成正文', status: '99', originalType: '1', sender: 'unknown', sentAt: null,
    partition: 'part-a', table: 'messages-a', localId: '1', serverId: null };
  vault.appendPage([first]);

  const databasePath = join(root, 'vault.sqlite');
  await chmod(root, 0o755);
  await chmod(databasePath, 0o644);
  const before = { rootMode: (await lstat(root)).mode & 0o777, databaseMode: (await lstat(databasePath)).mode & 0o777 };
  const source = client();
  assert.deepEqual(await verifyQuarantineIdentity(source, root), {
    identity: 'matched', normalHistory: false, stateAssurance: 'unverified', continuity: 'not_verified_across_restarts',
  });
  const status = await QuarantineVault.inspect(root);
  const after = { rootMode: (await lstat(root)).mode & 0o777, databaseMode: (await lstat(databasePath)).mode & 0o777 };
  assert.equal(status.snapshotState, 'running');
  assert.equal(status.recordCount, 1);
  assert.deepEqual(after, before);
  assert.equal(vault.list({ limit: 10 }).records[0].text, first.text);

  vault.appendPage([{ ...first, localId: '2', text: '复核后继续追加的合成正文' }]);
  assert.equal(vault.summary().snapshotState, 'running');
  vault.complete({ scopeDigest: digest(original), completedPartitions: ['part-a'], sourceContinuity: 'held', snapshotComplete: true });
  assert.deepEqual(vault.list({ limit: 10 }).records.map(record => record.state), ['unverified', 'unverified']);
  assert.equal(vault.summary().snapshotComplete, true);
  assert.equal(source.events.pages, 0);
  assert.equal(source.events.closed, true);
});

test('状态未核验、metadata失败或会话匹配歧义均折叠为通用失败并关闭client', async t => {
  const { root } = await fixture(t);
  for (const source of [
    client({ status: 'unverified' }),
    client({ accountError: 'private-account-detail' }),
    client({ resolveError: 'private-ambiguous-contact-detail' }),
  ]) {
    await assert.rejects(verifyQuarantineIdentity(source, root), error => error.code === 'identity_unverified' && error.message === 'identity_unverified');
    assert.equal(source.events.pages, 0);
    assert.equal(source.events.closed, true);
  }
});

test('CLI verify要求绝对vault路径和executable且拒绝额外参数', async () => {
  await assert.rejects(runQuarantineCli(['verify', '--root', 'relative', '--executable', '/synthetic/cli']), /quarantine_arguments_invalid/);
  await assert.rejects(runQuarantineCli(['verify', '--root', '/synthetic/vault']), /quarantine_arguments_invalid/);
  await assert.rejects(runQuarantineCli(['verify', '--root', '/synthetic/vault', '--executable', '/synthetic/cli', '--contact', '合成联系人']), /quarantine_arguments_invalid/);
});

test('CLI view拒绝打开正在导入的隔离仓，保留原快照', async t => {
  const base = await mkdtemp(join(tmpdir(), 'notalone-quarantine-cli-active-'));
  const root = join(base, 'vault');
  const vault = await QuarantineVault.create(root, { scopeDigest: digest(original), displayName: '合成联系人' });
  t.after(async () => { try { vault.close(); } finally { await rm(base, { recursive: true, force: true }); } });
  vault.begin({ expectedPartitions: ['part-a'] });

  await assert.rejects(runQuarantineCli(['view', '--root', root]), /quarantine_snapshot_busy/);
  assert.equal((await QuarantineVault.inspect(root)).snapshotState, 'running');
});
