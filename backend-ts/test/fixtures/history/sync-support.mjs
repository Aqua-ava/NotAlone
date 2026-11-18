// 历史同步测试的共享合成夹具：单页历史＋可选增量尾部的最小渠道、联系人与历史服务装配。
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../../../src/storage/sqlite/client.ts';
import { SqliteContactService } from '../../../src/contacts/sqlite/service.ts';
import { SqliteHistoryService } from '../../../src/history/sqlite/service.ts';

export const owner = '00000000-0000-4000-8000-000000000086';
export const evidence = { externalKey: 'synthetic-account', identityScheme: 'wechat.account.v1', sourceGeneration: 'source-1', assurance: 'verified', supportProfile: 'synthetic-metadata-v1' };
export const record = (localId, changes = {}) => ({
  partition: 'p', table: 't', localId, serverId: '0', sender: 'contact', kind: 'text', text: `合成${localId}`,
  originalType: '1', sentAt: '1700000000000', timePrecision: 'second', orderScheme: null, orderKey: null, stateAssurance: 'verified', status: '0', ...changes,
});
export function support(scope, overrides = {}) {
  return {
    protocol: 'private-history-v1', profileId: 'synthetic-history-v1', adapterVersion: '1', status: 'supported', reason: null,
    accountKey: scope.accountKey, conversationKey: scope.conversationKey, sourceGeneration: scope.token.source_generation,
    programVersion: 'synthetic', build: '1', artifactSha256: 'a'.repeat(64), schemaFingerprint: 'b'.repeat(64),
    declaredPrimaryKey: ['local_id'], identity: 'source-table-local-v1', statusSemantics: 'synthetic-raw-codes',
    continuity: 'synthetic-source-1', serverAliasSemantics: 'unverified', capabilities: { incrementalTail: 'supported' }, ...overrides,
  };
}
export function createChannel(state) {
  return () => {
    state.creates++;
    return {
      inspect: async scope => support(scope, state.supportOverrides),
      target: async scope => {
        state.targetDescriptor = `synthetic:${scope.conversationKey}`;
        return { protocol: 'private-history-v1', descriptor: state.targetDescriptor, partitions: ['p'], tables: [{ partition: 'p', instance: 't' }], sourceGeneration: 'source-1' };
      },
      page: async (_scope, target, cursor) => ({
        target: target.descriptor, cursorIn: cursor, cursorOut: null, completedPartitions: ['p'], exhausted: true,
        records: state.historyRecords, ...(state.resumeCursor === null ? {} : { resumeCursor: state.resumeCursor }),
      }),
      close: async () => {},
    };
  };
}
export async function fixture(t, names = ['a']) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'notalone-incremental-handoff-')));
  const state = { creates: 0, supportOverrides: {}, historyRecords: [], resumeCursor: 'tail-1', targetDescriptor: null };
  const metadata = () => ({
    account: async () => ({ ...evidence }),
    sessions: async () => names.map(name => ({ externalKey: `friend-${name}`, displayName: `合成${name}`, kind: 'private', identityAssurance: 'verified' })),
  });
  const f = { root, state };
  f.storage = await SqliteStorage.open({ userData: root, intent: 'create', role: 'test' });
  f.contacts = new SqliteContactService(f.storage, owner, metadata());
  await f.contacts.initialize();
  f.history = new SqliteHistoryService(f.storage, f.contacts, createChannel(state));
  t.after(async () => { await f.history.close(); await f.contacts.close(); await f.storage.close(); await rm(root, { recursive: true, force: true }); });
  return f;
}
export async function select(f) {
  const candidate = await f.contacts.detectAccount();
  await f.contacts.confirmAccount(candidate.candidate_token);
  const snapshot = await f.contacts.candidates(true);
  await f.contacts.confirm(snapshot.snapshot_token, snapshot.sessions.map(row => ({ locator: row.username, observed_display_name: row.display_name, expected_selection_generation: row.selection_generation })));
  await f.contacts.setReading(true);
  return (await f.contacts.directory()).bindings[0];
}
