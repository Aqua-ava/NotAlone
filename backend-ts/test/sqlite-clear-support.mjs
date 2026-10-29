import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { SqliteContactService } from '../src/contacts/sqlite/service.ts';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import { SqliteHistoryClearService } from '../src/history/sqlite/clear.ts';
import { SqliteHistoryResyncService } from '../src/history/sqlite/resync.ts';
import { DeletionService } from '../src/storage/sqlite/deletion/service.ts';
import { ManagedFiles } from '../src/storage/sqlite/deletion/managed-files.ts';
import { ActiveHolders } from '../src/storage/sqlite/deletion/holders.ts';
import { boundaryProtocol, membersManifestSha256, sourceLocalKey } from '../src/history/sqlite/boundary.ts';

export const owner = '00000000-0000-4000-8000-000000000001';
export const target = {
  protocol: 'private-history-v1', descriptor: 'fixed-synthetic-target',
  partitions: ['shard-a', 'shard-b'],
  tables: [{ partition: 'shard-a', instance: 'table-a' }, { partition: 'shard-b', instance: 'table-b' }],
  sourceGeneration: 'source-1',
};
export const report = {
  protocol: 'private-history-v1', profileId: 'synthetic-boundary-v1', adapterVersion: '1',
  status: 'supported', reason: null, programVersion: 'synthetic', build: '1',
  artifactSha256: 'a'.repeat(64), schemaFingerprint: 'b'.repeat(64), declaredPrimaryKey: ['local_id'],
  identity: 'source-table-local-v1', statusSemantics: 'synthetic-final-rows',
  continuity: 'synthetic-generation-1', serverAliasSemantics: 'verified_within_scope',
  capabilities: { [boundaryProtocol]: 'supported' },
};
const instanceFor = partition => target.tables.find(table => table.partition === partition).instance;
export function record(partition, localId, extra = {}) {
  return { partition, table: instanceFor(partition), localId: String(localId), serverId: '0', sender: 'contact',
    kind: 'text', text: `合成正文${localId}`, originalType: '1', sentAt: '1700000000000', timePrecision: 'second',
    orderScheme: null, orderKey: null, ...extra };
}
export const identity = (partition, localId) => ({ partition, localId: String(localId) });
export const identities = list => list.map(([partition, localId]) => identity(partition, localId));
export function buildCandidate(scope, members, options = {}) {
  const sorted = members.map(member => ({
    partition: member.partition, tableInstance: instanceFor(member.partition),
    localKey: sourceLocalKey(scope.token.source_generation, member.partition, instanceFor(member.partition), String(member.localId)),
  })).sort((left, right) => left.localKey.localeCompare(right.localKey));
  const partitions = target.partitions.map(partition => {
    const sample = options.samples?.[partition] ?? { pre: 'sample-1', post: 'sample-1' };
    return { partition, instance: instanceFor(partition), preSample: sample.pre, postSample: sample.post,
      readerCompleted: options.readerCompleted ?? true,
      memberCount: members.filter(member => member.partition === partition).length };
  });
  const support = { ...report, accountKey: scope.accountKey, conversationKey: scope.conversationKey,
    sourceGeneration: scope.token.source_generation, ...(options.support ?? {}) };
  return { protocol: boundaryProtocol, target: { ...target, partitions: [...target.partitions], tables: target.tables.map(t => ({ ...t })) },
    support, accountKey: scope.accountKey, conversationKey: scope.conversationKey,
    sourceGeneration: scope.token.source_generation, boundaryToken: options.boundaryToken ?? 'synthetic-boundary-token',
    manifestSha256: options.manifestSha256 ?? membersManifestSha256(target.descriptor, sorted),
    members: members.map(member => ({ partition: member.partition, table: instanceFor(member.partition), localId: String(member.localId) })),
    partitions, namespaceContinuity: options.namespaceContinuity ?? true,
    instanceContinuity: options.instanceContinuity ?? true, observedAt: new Date().toISOString() };
}
export function createChannel(options = {}) {
  const state = { inspectCalls: 0, pageCalls: 0, boundaryCalls: 0, closed: 0,
    pageRecords: [], pageFactory: null, pageHook: null, boundaryHook: null, boundaryFactory: null,
    boundaryMembers: [], boundaryOptions: {}, inspectFactory: null, boundaryAvailable: options.boundary !== false };
  const channel = {
    async inspect(scope) {
      state.inspectCalls++;
      if (state.inspectFactory) return state.inspectFactory(scope, state);
      return { ...report, accountKey: scope.accountKey, conversationKey: scope.conversationKey,
        sourceGeneration: scope.token.source_generation };
    },
    async target(scope) { return { ...target, sourceGeneration: scope?.token?.source_generation ?? target.sourceGeneration,
      partitions: [...target.partitions], tables: target.tables.map(t => ({ ...t })) }; },
    async page(scope, fixed, cursor) {
      state.pageCalls++;
      if (state.pageHook) await state.pageHook(state);
      if (state.pageFactory) return state.pageFactory(scope, cursor, state);
      return { target: fixed.descriptor, cursorIn: cursor, cursorOut: null,
        records: state.pageRecords, completedPartitions: [...target.partitions], exhausted: true };
    },
  };
  if (state.boundaryAvailable) channel.boundarySnapshot = async scope => {
    state.boundaryCalls++;
    if (state.boundaryHook) await state.boundaryHook(state);
    if (state.boundaryFactory) return state.boundaryFactory(scope, state);
    return buildCandidate(scope, state.boundaryMembers, state.boundaryOptions);
  };
  return { channel, state };
}
const metadata = {
  account: async () => ({ externalKey: 'synthetic-account', identityScheme: 'wechat.account.v1',
    sourceGeneration: 'source-1', assurance: 'verified', supportProfile: 'synthetic-metadata-v1' }),
  sessions: async () => [{ externalKey: 'friend-a', displayName: '合成甲', kind: 'private', identityAssurance: 'verified' },
    { externalKey: 'friend-b', displayName: '合成乙', kind: 'private', identityAssurance: 'verified' }],
};
async function attach(ctx, storage) {
  const holders = new ActiveHolders();
  const contacts = new SqliteContactService(storage, owner, metadata);
  const deletion = new DeletionService(storage, holders, new ManagedFiles(ctx.root), { drainTimeoutMs: 2_000 });
  const history = new SqliteHistoryService(storage, contacts, () => ctx.channel, holders);
  const clear = new SqliteHistoryClearService(storage, contacts, () => ctx.channel, deletion, holders,
    { maxBoundaryAttempts: ctx.maxBoundaryAttempts ?? 3 });
  const resync = new SqliteHistoryResyncService(storage, contacts, () => ctx.channel, holders);
  ctx.current = { storage, holders, contacts, deletion, history, clear, resync };
  return ctx.current;
}
export async function closeCurrent(ctx) {
  const current = ctx.current;
  if (!current) return;
  ctx.current = null;
  await current.resync.close().catch(() => {});
  await current.clear.close().catch(() => {});
  await current.history.close().catch(() => {});
  await current.storage.close().catch(() => {});
}
export async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'notalone-clear-')));
  const { channel, state } = options.channel ? { channel: options.channel, state: options.state } : createChannel();
  const ctx = { root, channel, state, maxBoundaryAttempts: options.maxBoundaryAttempts, registryModule: options.registryModule };
  const storage = await SqliteStorage.open({ userData: root, intent: 'create', role: 'test', ...(options.registryModule ? { registryModule: options.registryModule } : {}) });
  const current = await attach(ctx, storage);
  await current.contacts.initialize();
  const candidate = await current.contacts.detectAccount();
  await current.contacts.confirmAccount(candidate.candidate_token);
  await current.contacts.setReading(true);
  const snapshot = await current.contacts.candidates(true);
  const saved = await current.contacts.confirm(snapshot.snapshot_token, snapshot.sessions.map(session => ({
    locator: session.username, observed_display_name: session.display_name,
    expected_selection_generation: session.selection_generation })));
  ctx.saved = saved.bindings;
  ctx.contactA = saved.bindings[0].contact_id;
  ctx.contactB = saved.bindings[1].contact_id;
  t.after(async () => { await closeCurrent(ctx); await rm(root, { recursive: true, force: true }); });
  return ctx;
}
export async function restart(ctx, t) {
  const previous = ctx.current;
  const databaseId = previous.storage.status.databaseId;
  await closeCurrent(ctx);
  const storage = await SqliteStorage.open({ userData: ctx.root, intent: 'open', role: 'test', expectedDatabaseId: databaseId, ...(ctx.registryModule ? { registryModule: ctx.registryModule } : {}) });
  const current = await attach(ctx, storage);
  t.after(async () => { await closeCurrent(ctx); });
  return current;
}
/** 有界等待，用于确认后台/并发路径已推进；不用于替代事件。 */
export async function waitFor(predicate, label, timeoutMs = 2_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`waitFor timeout: ${label}`);
}
