import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuarantineVault } from '../src/history/quarantine-vault.ts';
import { QuarantineLibrary } from '../src/history/quarantine-library.ts';

const digest = 'd'.repeat(64);
const validId = 'snapshot-20261030-5e28493d-b9e7-4ec0-b8e6-f5d5a62c6b79';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'notalone-quarantine-library-'));
  const root = join(base, 'quarantine');
  await mkdir(root, { mode: 0o700 });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, root, library: new QuarantineLibrary(root) };
}

async function makeSnapshot(root, id, text = '合成隔离文字') {
  const vault = await QuarantineVault.create(join(root, id), { scopeDigest: digest, displayName: '测试联系人' });
  vault.begin({ expectedPartitions: ['part-1'] });
  vault.appendPage([{ kind: 'text', text, status: '4', originalType: '1', sender: 'unknown', sentAt: null,
    partition: 'part-1', table: 'table-1', localId: '1', serverId: null }]);
  vault.complete({ scopeDigest: digest, sourceContinuity: 'held', snapshotComplete: true, completedPartitions: ['part-1'] });
  return vault;
}

test('固定目录不存在时列出空仓，打开拒绝路径穿越与非快照名称', async t => {
  const base = await mkdtemp(join(tmpdir(), 'notalone-quarantine-library-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const library = new QuarantineLibrary(join(base, 'not-created'));
  assert.deepEqual(await library.list(), []);
  await assert.rejects(library.open('../outside'), { code: 'quarantine_snapshot_id_invalid' });
  await assert.rejects(library.open('/tmp/snapshot-20261030-' + validId.slice(-36)), { code: 'quarantine_snapshot_id_invalid' });
});

test('仅枚举安全命名且通过隔离库校验的一级仓，并能打开读取及删除后重计数', async t => {
  const { root, library } = await fixture(t);
  const original = await makeSnapshot(root, validId);
  original.close();

  const rejectedName = await makeSnapshot(root, 'private-copy');
  rejectedName.close();
  await mkdir(join(root, 'snapshot-20261030-00000000-0000-0000-0000-000000000000'));
  await writeFile(join(root, 'snapshot-20261030-00000000-0000-0000-0000-000000000001'), 'not a directory');

  const entries = await library.list();
  assert.deepEqual(entries.map(entry => entry.id), [validId]);
  assert.equal(entries[0].status.recordCount, 1);
  assert.equal(entries[0].status.normalHistory, false);
  assert.equal(entries[0].status.snapshotComplete, true);

  const vault = await library.open(validId);
  assert.equal(vault.list({ limit: 10 }).records[0].state, 'unverified');
  const recordId = vault.list({ limit: 10 }).records[0].id;
  assert.equal(vault.delete(recordId), true);
  vault.close();
  assert.equal((await library.list())[0].status.recordCount, 0);
});

test('跳过软链、损坏仓及嵌套仓，且不能通过伪造ID打开', async t => {
  const { base, root, library } = await fixture(t);
  const valid = await makeSnapshot(root, validId);
  valid.close();
  await symlink(join(root, validId), join(root, 'snapshot-20261030-5e28493d-b9e7-4ec0-b8e6-f5d5a62c6b78'));
  const broken = join(root, 'snapshot-20261030-5e28493d-b9e7-4ec0-b8e6-f5d5a62c6b77');
  await mkdir(broken);
  await writeFile(join(broken, 'vault.sqlite'), 'invalid');
  await mkdir(join(root, 'nested'));
  const nested = await makeSnapshot(join(root, 'nested'), 'snapshot-20261030-5e28493d-b9e7-4ec0-b8e6-f5d5a62c6b76');
  nested.close();

  assert.deepEqual((await library.list()).map(entry => entry.id), [validId]);
  await assert.rejects(library.open('snapshot-20261030-5e28493d-b9e7-4ec0-b8e6-f5d5a62c6b78'), { code: 'quarantine_root_invalid' });
  await assert.rejects(library.open('snapshot-20261030-5e28493d-b9e7-4ec0-b8e6-f5d5a62c6b77'), { code: 'quarantine_database_corrupt' });

  const parentLink = join(base, 'quarantine-link');
  await symlink(root, parentLink);
  await assert.rejects(new QuarantineLibrary(parentLink).list(), { code: 'quarantine_root_invalid' });
  await assert.rejects(new QuarantineLibrary(parentLink).open(validId), { code: 'quarantine_root_invalid' });
});

test('library.list只读检查运行中的仓，open明确拒绝且导入可继续', async t => {
  const { root, library } = await fixture(t);
  const vault = await QuarantineVault.create(join(root, validId), { scopeDigest: digest, displayName: '测试联系人' });
  t.after(() => vault.close());
  vault.begin({ expectedPartitions: ['part-1'] });
  vault.appendPage([{ kind: 'text', text: '第一条合成文字', status: '4', originalType: '1', sender: 'unknown', sentAt: null,
    partition: 'part-1', table: 'table-1', localId: '1', serverId: null }]);
  await chmod(join(root, validId), 0o755);
  await chmod(join(root, validId, 'vault.sqlite'), 0o644);
  try {
    const rootBefore = await lstat(join(root, validId));
    const databaseBefore = await lstat(join(root, validId, 'vault.sqlite'));
    const entries = await library.list();
    const rootAfter = await lstat(join(root, validId));
    const databaseAfter = await lstat(join(root, validId, 'vault.sqlite'));
    assert.equal(entries[0].status.snapshotState, 'running');
    assert.equal(rootAfter.mode & 0o777, rootBefore.mode & 0o777);
    assert.equal(databaseAfter.mode & 0o777, databaseBefore.mode & 0o777);
    assert.equal(rootAfter.mtimeMs, rootBefore.mtimeMs);
    assert.equal(databaseAfter.mtimeMs, databaseBefore.mtimeMs);

    await assert.rejects(library.open(validId), { code: 'quarantine_snapshot_busy' });
    assert.equal(vault.summary().snapshotState, 'running');
    vault.appendPage([{ kind: 'text', text: '第二条合成文字', status: '4', originalType: '1', sender: 'unknown', sentAt: null,
      partition: 'part-1', table: 'table-1', localId: '2', serverId: null }]);
    assert.equal(vault.summary().recordCount, 2);
    vault.complete({ scopeDigest: digest, sourceContinuity: 'held', snapshotComplete: true, completedPartitions: ['part-1'] });
  } finally {
    await chmod(join(root, validId, 'vault.sqlite'), 0o600);
    await chmod(join(root, validId), 0o700);
  }

});
