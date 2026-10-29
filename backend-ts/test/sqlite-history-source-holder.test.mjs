import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { SqliteContactService } from '../src/contacts/sqlite/service.ts';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import { ActiveHolders } from '../src/storage/sqlite/deletion/holders.ts';
import { DeletionService } from '../src/storage/sqlite/deletion/service.ts';
import { ManagedFiles } from '../src/storage/sqlite/deletion/managed-files.ts';

const owner = '00000000-0000-4000-8000-000000000083';
const metadata = () => ({
  account: async () => ({ externalKey: 'synthetic-account', identityScheme: 'wechat.account.v1', sourceGeneration: 'source-1', assurance: 'verified', supportProfile: 'synthetic-metadata-v1' }),
  sessions: async () => ['a', 'b'].map(name => ({ externalKey: `friend-${name}`, displayName: `合成${name}`, kind: 'private', identityAssurance: 'verified' })),
});
const channel = () => ({
  inspect: async scope => ({ protocol: 'private-history-v1', profileId: 'synthetic-history-v1', adapterVersion: '1', status: 'supported', reason: null,
    accountKey: scope.accountKey, conversationKey: scope.conversationKey, sourceGeneration: scope.token.source_generation,
    programVersion: 'synthetic', build: '1', artifactSha256: 'a'.repeat(64), schemaFingerprint: 'b'.repeat(64), declaredPrimaryKey: ['local_id'],
    identity: 'source-table-local-v1', statusSemantics: 'synthetic-final', continuity: 'synthetic-source', serverAliasSemantics: 'unverified' }),
  target: async () => ({ protocol: 'private-history-v1', descriptor: 'synthetic-target', partitions: ['p'], tables: [{ partition: 'p', instance: 't' }], sourceGeneration: 'source-1' }),
  page: async (_scope, target, cursor) => ({ target: target.descriptor, cursorIn: cursor, cursorOut: null, completedPartitions: ['p'], exhausted: true,
    records: ['1', '2', '3'].map(localId => ({ partition: 'p', table: 't', localId, serverId: '0', sender: 'contact', kind: 'text', text: `合成来源${localId}`,
      originalType: '1', sentAt: '1700000000000', timePrecision: 'second', orderScheme: null, orderKey: null, status: '0' })) }),
});

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-source-holder-')));
  const storage = await SqliteStorage.open({ userData: root, intent: 'create', role: 'test',
    registryModule: new URL('./fixtures/history/registry.mjs', import.meta.url).href });
  const holders = new ActiveHolders(), readers = [];
  const contacts = new SqliteContactService(storage, owner, metadata());
  t.after(async () => {
    for (const reader of readers) reader.release();
    await Promise.all(readers.map(reader => reader.history.close()));
    await Promise.allSettled(readers.map(reader => reader.run));
    await contacts.close(); await storage.close(); await rm(root, { recursive: true, force: true });
  });
  await contacts.initialize();
  const candidate = await contacts.detectAccount(); await contacts.confirmAccount(candidate.candidate_token); await contacts.setReading(true);
  const snapshot = await contacts.candidates(true);
  await contacts.confirm(snapshot.snapshot_token, snapshot.sessions.map(row => ({ locator: row.username, observed_display_name: row.display_name, expected_selection_generation: '0' })));
  const bindings = (await contacts.directory()).bindings;
  const history = new SqliteHistoryService(storage, contacts, channel, holders);
  const sources = [];
  try {
    for (const binding of bindings) {
      await history.synchronize(binding.contact_id);
      sources.push((await history.read(binding.contact_id)).messages.map(message => message.sourceRecordIds[0]));
    }
  } finally { await history.close(); }
  return { storage, holders, contacts, bindings, sources, readers,
    deletion: new DeletionService(storage, holders, new ManagedFiles(root), { drainTimeoutMs: 20 }) };
}

function holdInspect(f, contactId) {
  let entered, release, complete, closeCalls = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const closing = new Promise(resolve => { release = resolve; });
  const port = channel(), inspect = port.inspect;
  port.inspect = async scope => { entered(); return new Promise(resolve => { complete = () => resolve(inspect(scope)); }); };
  port.close = async () => { closeCalls++; await closing; complete?.(); };
  const history = new SqliteHistoryService(f.storage, f.contacts, port, f.holders);
  const run = history.support(contactId); run.catch(() => {});
  const reader = { history, run, release, closeCalls: () => closeCalls,
    ready: Promise.race([ready, run.then(() => { throw new Error('合成inspect未保持在途'); })]) };
  f.readers.push(reader);
  return reader;
}

const planSource = (f, contactId, sourceId, requestKey) => f.deletion.plan({ ownerId: owner, requestKey, scope: { kind: 'source', contactId, sourceId } });

test('连续来源删除覆盖没有goal且跨过中间代次的早期inspect读者', async t => {
  const f = await fixture(t), contact = f.bindings[0].contact_id, sources = f.sources[0];
  const first = await planSource(f, contact, sources[0], 'first-source');
  assert.equal((await f.deletion.advance(first)).state, 'completed');
  const reader = holdInspect(f, contact); await reader.ready;
  const second = await planSource(f, contact, sources[1], 'second-source');
  const third = await planSource(f, contact, sources[2], 'third-source');
  assert.equal(second.acceptedGeneration, 2n); assert.equal(third.acceptedGeneration, 3n);
  const blocked = await f.deletion.advance(third);
  assert.equal(blocked.state, 'blocked', '代次1读者尚未释放，代次3删除不得完成');
  assert.equal(reader.closeCalls(), 1);
  reader.release();
  await assert.rejects(reader.run, { code: 'history_interrupted' });
  assert.equal((await f.deletion.advance(third)).state, 'completed');
});

test('来源fence保留新合法代次、其他联系人及未声明来源覆盖的领域', async t => {
  const f = await fixture(t), a = f.bindings[0].contact_id, b = f.bindings[1].contact_id;
  let unrelatedCloses = 0;
  const releaseUnrelated = f.holders.register({ key: 'synthetic:unrelated', ownerId: owner, contactId: a, generation: 0n,
    close: async () => { unrelatedCloses++; } });
  try {
    const operation = await planSource(f, a, f.sources[0][0], 'source-fence');
    const fresh = holdInspect(f, a), other = holdInspect(f, b);
    await Promise.all([fresh.ready, other.ready]);
    assert.equal((await f.deletion.advance(operation)).state, 'completed');
    assert.equal(fresh.closeCalls(), 0, '接受代次的新读者仍合法');
    assert.equal(other.closeCalls(), 0, '其他联系人不能被停止');
    assert.equal(unrelatedCloses, 0, '没有来源覆盖声明的领域沿用原合同');
    assert.throws(() => f.holders.register({ key: 'synthetic:late-source', ownerId: owner, contactId: a, generation: 0n, coversAllSources: true,
      close: async () => {} }), { code: 'deletion_holder_fenced' });
    const lateUnrelated = f.holders.register({ key: 'synthetic:late-unrelated', ownerId: owner, contactId: a, generation: 0n, close: async () => {} });
    await lateUnrelated();
  } finally { await releaseUnrelated(); }
});
