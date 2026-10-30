import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { QuarantineVault } from '../src/history/quarantine-vault.ts';

const digest = 'a'.repeat(64);
function textRecord(overrides = {}) {
  return { kind: 'text', text: '合成隔离文字', status: '4', originalType: '1', sender: 'unknown', sentAt: '1793350800000',
    partition: 'part-1', table: 'message-table-instance-1', localId: '17', serverId: null, ...overrides };
}
async function parent(t) {
  const root = await mkdtemp(join(tmpdir(), 'notalone-quarantine-vault-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function create(t, options = {}) {
  const root = join(await parent(t), 'vault');
  const vault = await QuarantineVault.create(root, { scopeDigest: digest, displayName: 'ran', ...options });
  t.after(() => vault.close());
  return { root, vault };
}

test('创建独立私有空仓，只接受新空目录并收紧数据库权限', async t => {
  const root = join(await parent(t), 'new-vault');
  const vault = await QuarantineVault.create(root, { scopeDigest: digest, displayName: 'ran' });
  t.after(() => vault.close());
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(root), ['vault.sqlite']);
  assert.equal((await lstat(join(root, 'vault.sqlite'))).mode & 0o777, 0o600);

  const occupied = join(await parent(t), 'occupied');
  await mkdir(occupied);
  await writeFile(join(occupied, 'keep.txt'), '合成保留文件');
  await assert.rejects(QuarantineVault.create(occupied, { scopeDigest: digest, displayName: 'ran' }), { code: 'quarantine_root_not_empty' });
  assert.equal((await readdir(occupied)).join(','), 'keep.txt');
});

test('只保存文字为未核验隔离记录，非文字跳过，完成仅证明快照收束', async t => {
  const { vault } = await create(t);
  vault.begin({ expectedPartitions: ['part-1'] });
  assert.throws(() => vault.appendPage([textRecord()], { scopeDigest: 'b'.repeat(64) }), { code: 'quarantine_scope_mismatch' });
  assert.equal(vault.summary().recordCount, 0);
  const written = vault.appendPage([textRecord(), textRecord({ kind: 'image', text: '不应保存' })]);
  assert.deepEqual({ saved: written.saved, skippedNonText: written.skippedNonText, page: written.page }, { saved: 1, skippedNonText: 1, page: 1 });

  const page = vault.list({ limit: 10 });
  assert.equal(page.records.length, 1);
  assert.equal(page.records[0].text, '合成隔离文字');
  assert.equal(page.records[0].state, 'unverified');
  assert.equal(page.records[0].kind, 'text');
  assert.equal(page.records[0].sender, 'unknown');
  assert.equal(page.records.some(record => record.text === '不应保存'), false);
  assert.equal(vault.summary().snapshotState, 'running');

  const complete = vault.complete({ scopeDigest: digest, sourceContinuity: 'held', snapshotComplete: true, completedPartitions: ['part-1'] });
  assert.equal(complete.snapshotState, 'complete');
  assert.equal(vault.list({ limit: 10 }).records[0].state, 'unverified');
  assert.throws(() => vault.appendPage([textRecord()]), { code: 'quarantine_not_running' });
});

test('文字缺失或超过上限时逐条跳过并持久报告不可保存数量', async t => {
  const { vault } = await create(t);
  vault.begin({ expectedPartitions: ['part-1'] });
  const result = vault.appendPage([
    textRecord({ text: null, localId: '18' }),
    textRecord({ text: 'x'.repeat(1_000_001), localId: '19' }),
    textRecord({ text: '保留的合成文字', localId: '20' }),
    textRecord({ kind: 'voice', text: '不保存媒体正文', localId: '21' }),
  ]);
  assert.equal(result.saved, 1);
  assert.equal(result.skippedUnavailableText, 2);
  assert.equal(result.skippedNonText, 1);
  assert.equal(vault.summary().unavailableTextCount, 2);
  assert.deepEqual(vault.list({ limit: 10 }).records.map(record => record.text), ['保留的合成文字']);
  assert.equal(vault.abort('snapshot_failed').snapshotState, 'incomplete');
});

test('来源失效或中断时保留隔离文字但标记不完整且不可续写', async t => {
  const { vault } = await create(t);
  vault.begin({ expectedPartitions: ['part-1', 'part-2'] });
  vault.appendPage([textRecord()]);
  const result = vault.abort('source_continuity_lost');
  assert.equal(result.snapshotState, 'incomplete');
  assert.equal(result.sourceContinuity, 'lost');
  assert.equal(result.failureCode, 'source_continuity_lost');
  assert.equal(vault.list({ limit: 10 }).records[0].text, '合成隔离文字');
  assert.throws(() => vault.complete({ scopeDigest: digest, sourceContinuity: 'held', snapshotComplete: true, completedPartitions: ['part-1', 'part-2'] }), { code: 'quarantine_not_running' });
  assert.throws(() => vault.appendPage([textRecord()]), { code: 'quarantine_not_running' });
});

test('按记录ID稳定分页，删除单条或全部后正文不可再读取', async t => {
  const { vault } = await create(t);
  vault.begin({ expectedPartitions: ['part-1'] });
  vault.appendPage([
    textRecord({ text: '第一条合成内容', localId: '1' }),
    textRecord({ text: '第二条合成内容', localId: '2' }),
    textRecord({ text: '第三条合成内容', localId: '3' }),
  ]);
  vault.complete({ scopeDigest: digest, sourceContinuity: 'held', snapshotComplete: true, completedPartitions: ['part-1'] });

  const first = vault.list({ limit: 2 });
  assert.equal(first.records.length, 2);
  assert.ok(first.nextCursor);
  const second = vault.list({ limit: 2, after: first.nextCursor });
  assert.equal(second.records.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.records, ...second.records].map(record => record.id)).size, 3);

  assert.equal(vault.delete(first.records[0].id), true);
  assert.equal(vault.list({ limit: 10 }).records.some(record => record.id === first.records[0].id), false);
  assert.equal(vault.deleteAll(), 2);
  assert.equal(vault.list({ limit: 10 }).records.length, 0);
});

test('重开时将遗留运行快照变为来源失效的不完整状态并核对范围摘要', async t => {
  const root = join(await parent(t), 'vault');
  let vault = await QuarantineVault.create(root, { scopeDigest: digest, displayName: 'ran' });
  vault.begin({ expectedPartitions: ['part-1'] });
  vault.appendPage([textRecord()]);
  vault.close();

  await assert.rejects(QuarantineVault.open(root, { scopeDigest: 'b'.repeat(64) }), { code: 'quarantine_scope_mismatch' });
  vault = await QuarantineVault.open(root);
  t.after(() => vault.close());
  assert.equal(vault.summary().snapshotState, 'incomplete');
  assert.equal(vault.summary().sourceContinuity, 'lost');
  assert.equal(vault.list({ limit: 10 }).records[0].text, '合成隔离文字');
});

test('拒绝符号链接根目录', async t => {
  const parentPath = await parent(t);
  const target = join(parentPath, 'target');
  await mkdir(target);
  const link = join(parentPath, 'link');
  await symlink(target, link);
  await assert.rejects(QuarantineVault.create(link, { scopeDigest: digest, displayName: 'ran' }), { code: 'quarantine_root_invalid' });
});

test('打开未知SQLite文件前先只读验证且不改动目录或文件', async t => {
  const root = join(await parent(t), 'unknown-root');
  await mkdir(root);
  await chmod(root, 0o755);
  const database = join(root, 'vault.sqlite');
  const unknown = new DatabaseSync(database);
  unknown.exec('CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES (\'keep\');');
  unknown.close();
  await chmod(database, 0o644);
  const bytes = await readFile(database);
  await assert.rejects(QuarantineVault.open(root), { code: 'quarantine_database_invalid' });
  assert.deepEqual(await readFile(database), bytes);
  assert.equal((await lstat(root)).mode & 0o777, 0o755);
  assert.equal((await lstat(database)).mode & 0o777, 0o644);
});

test('删除全部压缩SQLite文件，隔离正文不留在库页中', async t => {
  const { root, vault } = await create(t);
  const secret = 'synthetic-erasure-sentinel-26017';
  vault.begin({ expectedPartitions: ['part-1'] });
  vault.appendPage([textRecord({ text: secret })]);
  vault.complete({ scopeDigest: digest, sourceContinuity: 'held', snapshotComplete: true, completedPartitions: ['part-1'] });
  assert.equal(vault.deleteAll(), 1);
  vault.close();
  assert.equal((await readFile(join(root, 'vault.sqlite'))).includes(Buffer.from(secret)), false);
});
