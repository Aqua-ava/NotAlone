import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import type { HistoryPage, HistoryRecord, HistorySupportReport, HistoryTarget } from '../sqlite/contracts.ts';

export interface ResolvedWechatScope {
  accountKey: string; conversationKey: string; displayName: string; sourceGeneration: string;
}
export interface WechatSchemaColumn { name: string; type: string; notNull: boolean; primaryKey: number; hidden: number }
export interface WechatIndexColumn { sequence: number; name: string; descending: boolean; collation: string; key: boolean }
export interface WechatSchemaIndex { id: string; unique: boolean; origin: 'c' | 'u' | 'pk'; partial: boolean; columns: WechatIndexColumn[] }
export interface WechatTableSchema {
  target: string; partition: string; role: 'private_message'; columns: WechatSchemaColumn[];
  indexes: WechatSchemaIndex[]; declaredPrimaryKey: string[]; autoIncrement: boolean;
  sqlFingerprint: string; triggerFingerprints: string[]; schemaVersion: string; rootPage: string;
}
export interface WechatSchemaInspection {
  format: 'wechat-message-schema-v1'; status: 'unverified'; scopeDigest: string;
  sourceGeneration: string; schemaFingerprint: string; tables: WechatTableSchema[]; checkedPartitions: string[];
}
export interface WechatAccountSchema {
  format: 'wechat-account-schema-v1'; status: 'unverified'; accountKey: string; sourceGeneration: string;
  schemaFingerprint: string; tables: (Omit<WechatTableSchema, 'role'> & {role: 'contact' | 'session'})[]; normalHistory: false;
}
export interface WechatAccountMetadata {
  format: 'wechat-account-metadata-v1'; status: 'verified' | 'unverified'; reason: string | null;
  accountKey: string; identityScheme: 'wechat.account.v1'; sourceGeneration: string; supportProfile: string;
  programVersion: string; build: string; artifactSha256: string; wcdbSha256: string;
  configuredAccount: 'verified' | 'unverified'; continuity: 'held-contact-session-instances'; normalHistory: false;
}
export interface WechatPrivateSessionMetadata {
  format: 'wechat-private-session-metadata-v1'; account: WechatAccountMetadata;
  sessions: {username: string; displayName: string; kind: 'private'; identityAssurance: 'verified'}[];
}
export interface WechatMessageMetadataRecord {
  partition: string; table: string; localId: string | null; serverId: string | null;
  originalType: string | null; status: string | null;
  // 原始秒字段仅作元数据观察，不转换或认证为消息发送时间。
  createTime: string | null; sender: 'owner' | 'contact' | 'unknown';
  statusSemantics: 'unverified'; normalHistory: false; observationScope: 'single-fixed-snapshot';
}
export interface WechatMessageMetadataObservation {
  format: 'wechat-message-metadata-observation-v1'; status: 'unverified'; scopeDigest: string;
  sourceGeneration: string; schemaFingerprint: string; kind: HistoryRecord['kind'];
  checkedPartitions: string[]; record: WechatMessageMetadataRecord | null;
}
export type WechatTestMetadataAction = 'arm' | 'next' | 'current';
export interface WechatTestMetadataObservation {
  format: 'wechat-test-metadata-observation-v1'; status: 'unverified'; scopeDigest: string;
  sourceGeneration: string; schemaFingerprint: string; action: WechatTestMetadataAction;
  checkedPartitions: string[]; lockedCount: number; records: (WechatMessageMetadataRecord | null)[];
}
export interface NarrowWechatClientOptions {
  executable: string; expectedCliSha256: string; expectedWcdbSha256: string;
  environment?: Record<string, string | undefined>;
}
const responseLimit = 2 * 1024 * 1024;
const pageResponseLimit = 8 * 1024 * 1024;
// 16×65536×最坏6倍JSON转义为6MiB，为有界元数据及游标保留2MiB。
const pageRecordLimit = 16;
const stderrLimit = 64 * 1024;
const digest = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
const fail = (code = 'history_protocol_invalid'): never => { throw new StorageFailure(code); };
const hashPattern = /^[a-f0-9]{64}$/;
const allowedErrors = new Set([
  'history_metadata_profile_unverified', 'history_program_version_uncertified',
  'history_request_invalid', 'history_operation_unsupported', 'history_scope_unverified',
  'history_account_unavailable', 'history_account_changed', 'history_native_unavailable',
  'history_metadata_unavailable', 'history_identity_unverified', 'history_identity_ambiguous',
  'history_source_changed', 'history_source_unverified', 'history_shards_unavailable',
  'history_shard_unavailable', 'history_schema_unavailable', 'history_schema_missing',
  'history_target_table_missing', 'history_target_ambiguous', 'history_target_not_private',
  'history_target_unverified', 'history_index_unavailable', 'history_trigger_unavailable',
  'history_schema_changed', 'history_scope_changed', 'history_native_timeout', 'history_native_cancelled',
  'history_native_closed', 'history_artifact_unverified', 'history_protocol_invalid',
  'history_response_too_large', 'history_stderr_limit', 'history_support_unverified',
  'history_support_unsupported', 'history_support_changed', 'history_target_invalid',
  'history_program_version_changed', 'history_program_version_invalid', 'history_program_version_unavailable',
  'history_cursor_invalid', 'history_message_state_unverified', 'history_nonce_unavailable',
  'history_page_budget_exhausted', 'history_page_read_failed', 'history_shards_changed',
  'history_snapshot_cancelled', 'history_snapshot_closed', 'history_snapshot_unavailable',
  'history_snapshot_window_changed', 'history_text_unknown', 'history_text_invalid',
  'history_test_sender_unverified', 'history_test_sender_ambiguous', 'history_test_new_rows_ambiguous',
  'history_test_type_unverified', 'history_test_key_unverified',
]);
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) return fail();
  return row;
}
function text(value: unknown, maximum = 255, empty = false): string {
  if (typeof value !== 'string' || !value.isWellFormed() || (!empty && !value.length) || Buffer.byteLength(value, 'utf8') > maximum || /[\u0000-\u001f\u007f]/.test(value)) return fail();
  return value;
}
function hash(value: unknown): string { return typeof value === 'string' && hashPattern.test(value) ? value : fail(); }
function exactInteger(value: unknown, nonnegative = false): string {
  if (typeof value !== 'string' || !/^(0|-?[1-9][0-9]{0,18})$/.test(value)) return fail();
  const parsed = BigInt(value);
  return parsed >= (nonnegative ? 0n : -9223372036854775808n) && parsed <= 9223372036854775807n ? value : fail();
}
function bool(value: unknown): boolean { return typeof value === 'boolean' ? value : fail(); }
function integer(value: unknown, maximum: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : fail();
}
function list<T>(value: unknown, maximum: number, parse: (value: unknown) => T, minimum = 0): T[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return fail();
  return value.map(parse);
}
function unique(values: readonly string[]): void { if (new Set(values).size !== values.length) fail(); }
function resolved(value: unknown): ResolvedWechatScope {
  const row = object(value, ['accountKey', 'conversationKey', 'displayName', 'sourceGeneration']);
  const accountKey = text(row.accountKey), conversationKey = text(row.conversationKey);
  if (![accountKey, conversationKey].every(key => /^[A-Za-z0-9_.@-]{1,255}$/.test(key))) return fail();
  return { accountKey, conversationKey, displayName: text(row.displayName), sourceGeneration: hash(row.sourceGeneration) };
}
function table(value: unknown): WechatTableSchema {
  const row = object(value, ['target', 'partition', 'role', 'columns', 'indexes', 'declaredPrimaryKey', 'autoIncrement', 'sqlFingerprint', 'triggerFingerprints', 'schemaVersion', 'rootPage']);
  if (row.role !== 'private_message') return fail();
  const columns = list(row.columns, 128, value => {
    const column = object(value, ['name', 'type', 'notNull', 'primaryKey', 'hidden']);
    return { name: text(column.name), type: text(column.type, 255, true), notNull: bool(column.notNull), primaryKey: integer(column.primaryKey, 128), hidden: integer(column.hidden, 3) };
  }, 1);
  unique(columns.map(column => column.name));
  const declaredPrimaryKey = list(row.declaredPrimaryKey, 128, value => text(value));
  const primary = columns.filter(column => column.primaryKey > 0).sort((a, b) => a.primaryKey - b.primaryKey);
  if (primary.some((column, index) => column.primaryKey !== index + 1) || JSON.stringify(declaredPrimaryKey) !== JSON.stringify(primary.map(column => column.name))) return fail();
  const indexes = list(row.indexes, 128, value => {
    const index = object(value, ['id', 'unique', 'origin', 'partial', 'columns']);
    if (index.origin !== 'c' && index.origin !== 'u' && index.origin !== 'pk') return fail();
    const columns = list(index.columns, 128, value => {
      const column = object(value, ['sequence', 'name', 'descending', 'collation', 'key']);
      return { sequence: integer(column.sequence, 127), name: text(column.name, 255, true), descending: bool(column.descending), collation: text(column.collation, 255, true), key: bool(column.key) };
    });
    if (columns.some((column, position) => column.sequence !== position)) return fail();
    return { id: hash(index.id), unique: bool(index.unique), origin: index.origin as 'c' | 'u' | 'pk', partial: bool(index.partial), columns };
  });
  unique(indexes.map(index => index.id));
  const triggerFingerprints = list(row.triggerFingerprints, 128, hash); unique(triggerFingerprints);
  return { target: hash(row.target), partition: hash(row.partition), role: 'private_message', columns, indexes, declaredPrimaryKey,
    autoIncrement: bool(row.autoIncrement), sqlFingerprint: hash(row.sqlFingerprint), triggerFingerprints, schemaVersion: exactInteger(row.schemaVersion), rootPage: exactInteger(row.rootPage, true) };
}
function inspection(value: unknown, scope: ResolvedWechatScope): WechatSchemaInspection {
  const row = object(value, ['format', 'status', 'scopeDigest', 'sourceGeneration', 'schemaFingerprint', 'tables', 'checkedPartitions']);
  if (row.format !== 'wechat-message-schema-v1' || row.status !== 'unverified') return fail();
  if (hash(row.scopeDigest) !== digest(`${scope.accountKey}\0${scope.conversationKey}`) || hash(row.sourceGeneration) !== scope.sourceGeneration) return fail();
  const checkedPartitions = list(row.checkedPartitions, 128, hash, 1); unique(checkedPartitions);
  const tables = list(row.tables, 128, table, 1); unique(tables.map(item => item.target));
  if (tables.some(item => !checkedPartitions.includes(item.partition))) return fail();
  return { format: 'wechat-message-schema-v1', status: 'unverified', scopeDigest: row.scopeDigest as string,
    sourceGeneration: scope.sourceGeneration, schemaFingerprint: hash(row.schemaFingerprint), tables, checkedPartitions };
}
function accountIdentity(value: unknown): string {
  const parsed = text(value);
  return /^[A-Za-z0-9_.@-]{1,255}$/.test(parsed) ? parsed : fail();
}
function accountSchema(value: unknown): WechatAccountSchema {
  const row = object(value, ['format', 'status', 'accountKey', 'sourceGeneration', 'schemaFingerprint', 'tables', 'normalHistory']);
  if (row.format !== 'wechat-account-schema-v1' || row.status !== 'unverified' || row.normalHistory !== false) return fail();
  const tables = list(row.tables, 2, value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    const role = (value as Record<string, unknown>).role;
    if (role !== 'contact' && role !== 'session') return fail();
    return { ...table({ ...value, role: 'private_message' }), role: role as 'contact' | 'session' };
  }, 2);
  unique(tables.map(item => item.role)); unique(tables.map(item => item.target));
  return { format: 'wechat-account-schema-v1', status: 'unverified', accountKey: accountIdentity(row.accountKey), sourceGeneration: hash(row.sourceGeneration), schemaFingerprint: hash(row.schemaFingerprint), tables, normalHistory: false };
}
function accountMetadata(value: unknown, options: NarrowWechatClientOptions): WechatAccountMetadata {
  const row = object(value, ['format', 'status', 'reason', 'accountKey', 'identityScheme', 'sourceGeneration', 'supportProfile', 'programVersion', 'build', 'artifactSha256', 'wcdbSha256', 'configuredAccount', 'continuity', 'normalHistory']);
  if (row.format !== 'wechat-account-metadata-v1' || row.identityScheme !== 'wechat.account.v1'
    || row.supportProfile !== 'wechat-4.0.6-29387-account-session-metadata-v1'
    || row.continuity !== 'held-contact-session-instances' || row.normalHistory !== false
    || hash(row.artifactSha256) !== options.expectedCliSha256 || hash(row.wcdbSha256) !== options.expectedWcdbSha256
    || typeof row.programVersion !== 'string' || !/^[0-9]{1,3}(\.[0-9]{1,3}){1,3}$/.test(row.programVersion)
    || typeof row.build !== 'string' || !/^[0-9]{1,12}$/.test(row.build)) return fail();
  if (row.status === 'verified') {
    if (row.configuredAccount !== 'verified' || row.reason !== null || row.programVersion !== '4.0.6' || row.build !== '29387') return fail();
  } else if (row.status !== 'unverified' || row.configuredAccount !== 'unverified'
    || !['history_metadata_profile_unverified', 'history_program_version_uncertified'].includes(row.reason as string)) return fail();
  return { format: 'wechat-account-metadata-v1', status: row.status as WechatAccountMetadata['status'], reason: row.reason as string | null,
    accountKey: accountIdentity(row.accountKey), identityScheme: 'wechat.account.v1', sourceGeneration: hash(row.sourceGeneration), supportProfile: row.supportProfile as string,
    programVersion: row.programVersion, build: row.build, artifactSha256: row.artifactSha256 as string, wcdbSha256: row.wcdbSha256 as string,
    configuredAccount: row.configuredAccount as WechatAccountMetadata['configuredAccount'], continuity: 'held-contact-session-instances', normalHistory: false };
}
function privateSessionMetadata(value: unknown, expected: WechatAccountMetadata, options: NarrowWechatClientOptions): WechatPrivateSessionMetadata {
  const row = object(value, ['format', 'account', 'sessions']);
  const account = accountMetadata(row.account, options);
  if (row.format !== 'wechat-private-session-metadata-v1' || account.status !== 'verified' || JSON.stringify(account) !== JSON.stringify(expected)) return fail();
  const sessions = list(row.sessions, 5000, value => {
    const item = object(value, ['username', 'displayName', 'kind', 'identityAssurance']);
    const username = accountIdentity(item.username);
    if (item.kind !== 'private' || item.identityAssurance !== 'verified' || username.startsWith('@') || username.startsWith('gh_') || username.startsWith('biz_')
      || ['@chatroom', '@weclaw', '@openim', '@stranger'].some(suffix => username.endsWith(suffix))
      || ['brandsessionholder', 'brandservicesessionholder'].includes(username)) return fail();
    return {username, displayName: text(item.displayName), kind: 'private' as const, identityAssurance: 'verified' as const};
  });
  unique(sessions.map(item => item.username));
  return {format: 'wechat-private-session-metadata-v1', account, sessions};
}
function opaque(value: unknown): string { return text(value, 64_000); }
function unsigned(value: unknown): string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n ? value : fail();
}
function supportReport(value: unknown, scope: ResolvedWechatScope, artifact: string): HistorySupportReport {
  const hasCapabilities = !!value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'capabilities');
  const row = object(value, ['protocol', 'profileId', 'adapterVersion', 'status', 'reason', 'accountKey', 'conversationKey', 'sourceGeneration',
    'programVersion', 'build', 'artifactSha256', 'schemaFingerprint', 'declaredPrimaryKey', 'serverAliasSemantics', 'identity', 'statusSemantics', 'continuity', ...(hasCapabilities ? ['capabilities'] : [])]);
  if (row.protocol !== 'private-history-v1' || row.identity !== 'source-table-local-v1' || row.serverAliasSemantics !== 'unverified'
    || !['supported', 'unsupported', 'unverified'].includes(row.status as string)
    || row.accountKey !== scope.accountKey || row.conversationKey !== scope.conversationKey || row.sourceGeneration !== scope.sourceGeneration || row.artifactSha256 !== artifact) return fail();
  const reason = row.reason === null ? null : text(row.reason, 128);
  if (reason !== null && !/^[a-z][a-z0-9_]*$/.test(reason)) return fail();
  const declaredPrimaryKey = list(row.declaredPrimaryKey, 128, value => text(value)); unique(declaredPrimaryKey);
  const statusSemantics = text(row.statusSemantics, 512, row.status !== 'supported');
  const continuity = text(row.continuity, 512, row.status !== 'supported');
  if (row.status === 'supported' && (reason !== null || !declaredPrimaryKey.length)) return fail();
  let capabilities: Record<string, 'supported' | 'unsupported' | 'unverified'> | undefined;
  if (hasCapabilities) {
    const keys = ['programVersion', 'exactSchema', 'declaredLocalKey', 'automaticAllocation', 'serverIdUniqueConstraint', 'statusColumn', 'statusSemantics', 'sourceLifecycle', 'restartContinuity', 'recoveryMapping', 'snapshotBarrier', 'partitionCoverage', 'normalHistory'];
    const reported = object(row.capabilities, keys);
    capabilities = Object.fromEntries(keys.map(key => {
      const value = reported[key];
      if (value !== 'supported' && value !== 'unsupported' && value !== 'unverified') return fail();
      return [key, value];
    }));
  }

  return { protocol: 'private-history-v1', profileId: text(row.profileId), adapterVersion: text(row.adapterVersion),
    status: row.status as HistorySupportReport['status'], reason, accountKey: scope.accountKey, conversationKey: scope.conversationKey,
    sourceGeneration: scope.sourceGeneration, programVersion: text(row.programVersion), build: text(row.build), artifactSha256: hash(row.artifactSha256),
    schemaFingerprint: hash(row.schemaFingerprint), declaredPrimaryKey, serverAliasSemantics: 'unverified', identity: 'source-table-local-v1', statusSemantics, continuity, ...(capabilities ? { capabilities } : {}) };
}
function historyTarget(value: unknown, scope: ResolvedWechatScope, schema?: WechatSchemaInspection): HistoryTarget {
  const row = object(value, ['protocol', 'descriptor', 'partitions', 'tables', 'sourceGeneration']);
  if (row.protocol !== 'private-history-v1' || row.sourceGeneration !== scope.sourceGeneration) return fail();
  const partitions = list(row.partitions, 128, hash, 1); unique(partitions);
  const tables = list(row.tables, 128, value => {
    const table = object(value, ['partition', 'instance']);
    return { partition: hash(table.partition), instance: hash(table.instance) };
  }, 1);
  unique(tables.map(table => table.instance));
  if (tables.some(table => !partitions.includes(table.partition))) return fail();
  if (schema && (JSON.stringify([...partitions].sort()) !== JSON.stringify([...new Set(schema.tables.map(table => table.partition))].sort())
    || JSON.stringify(tables.map(table => `${table.partition}:${table.instance}`).sort()) !== JSON.stringify(schema.tables.map(table => `${table.partition}:${table.target}`).sort()))) return fail();
  return { protocol: 'private-history-v1', descriptor: opaque(row.descriptor), partitions, tables, sourceGeneration: scope.sourceGeneration };
}
function historyRecord(value: unknown, target: HistoryTarget): HistoryRecord {
  const row = object(value, ['partition', 'table', 'localId', 'serverId', 'sender', 'kind', 'text', 'originalType', 'sentAt', 'timePrecision', 'orderScheme', 'orderKey', 'status', 'stateAssurance']);
  const partition = hash(row.partition), table = hash(row.table);
  if (!target.tables.some(candidate => candidate.partition === partition && candidate.instance === table)
    || !['owner', 'contact', 'unknown'].includes(row.sender as string)
    || !['text', 'image', 'voice', 'video', 'file', 'sticker', 'other'].includes(row.kind as string)
    || !['verified', 'unverified'].includes(row.stateAssurance as string) || row.stateAssurance === 'unverified' && row.text !== null) return fail();
  let body: string | null = null;
  if (row.kind === 'text') {
    if (row.text !== null) {
      if (typeof row.text !== 'string' || !row.text.isWellFormed() || Buffer.byteLength(row.text, 'utf8') > 65536) return fail();
      body = row.text;
    }
  } else if (row.text !== null) return fail();
  const sentAt = row.sentAt === null ? null : unsigned(row.sentAt);
  if ((sentAt === null) !== (row.timePrecision === null) || sentAt !== null && BigInt(sentAt) > 253402300799999n
    || row.timePrecision !== null && row.timePrecision !== 'second' && row.timePrecision !== 'millisecond') return fail();
  const orderScheme = row.orderScheme === null ? null : text(row.orderScheme, 512);
  const orderKey = row.orderKey === null ? null : exactInteger(row.orderKey);
  if ((orderScheme === null) !== (orderKey === null)) return fail();
  return { partition, table, localId: row.localId === null ? null : exactInteger(row.localId), serverId: row.serverId === null ? null : exactInteger(row.serverId),
    sender: row.sender as HistoryRecord['sender'], kind: row.kind as HistoryRecord['kind'], text: body, originalType: row.originalType === 'unknown' && row.kind === 'other' ? 'unknown' : exactInteger(row.originalType),
    sentAt, timePrecision: row.timePrecision as HistoryRecord['timePrecision'], orderScheme, orderKey, status: row.status === null ? null : exactInteger(row.status), stateAssurance: row.stateAssurance as HistoryRecord['stateAssurance'] };
}
function historyPage(value: unknown, target: HistoryTarget, cursor: string | null): HistoryPage {
  const row = object(value, ['target', 'cursorIn', 'cursorOut', 'records', 'completedPartitions', 'exhausted']);
  if (row.target !== target.descriptor || row.cursorIn !== cursor) return fail();
  const cursorOut = row.cursorOut === null ? null : opaque(row.cursorOut), exhausted = bool(row.exhausted);
  if (exhausted ? cursorOut !== null : cursorOut === null || cursorOut === cursor) return fail();
  const completedPartitions = list(row.completedPartitions, 128, hash); unique(completedPartitions);
  if (completedPartitions.some(partition => !target.partitions.includes(partition))) return fail();
  return { target: target.descriptor, cursorIn: cursor, cursorOut, records: list(row.records, pageRecordLimit, value => historyRecord(value, target)), completedPartitions, exhausted };
}
function metadataKind(originalType: string | null): HistoryRecord['kind'] {
  switch (originalType === null ? null : BigInt(originalType) & 0xffffffffn) {
    case 1n: return 'text';
    case 3n: return 'image';
    case 34n: return 'voice';
    case 43n: case 62n: return 'video';
    case 49n: return 'file';
    case 47n: return 'sticker';
    default: return 'other';
  }
}
function metadataRecord(value: unknown, schema: WechatSchemaInspection): WechatMessageMetadataRecord {
  const item = object(value, ['partition', 'table', 'localId', 'serverId', 'originalType', 'status', 'createTime', 'sender', 'statusSemantics', 'normalHistory', 'observationScope']);
  const partition = hash(item.partition), table = hash(item.table);
  if (!schema.tables.some(candidate => candidate.partition === partition && candidate.target === table)
    || !['owner', 'contact', 'unknown'].includes(item.sender as string)
    || item.statusSemantics !== 'unverified' || item.normalHistory !== false || item.observationScope !== 'single-fixed-snapshot') return fail();
  const nullableInteger = (value: unknown) => value === null ? null : exactInteger(value);
  return { partition, table, localId: nullableInteger(item.localId), serverId: nullableInteger(item.serverId),
    originalType: nullableInteger(item.originalType), status: nullableInteger(item.status), createTime: nullableInteger(item.createTime),
    sender: item.sender as WechatMessageMetadataRecord['sender'], statusSemantics: 'unverified', normalHistory: false, observationScope: 'single-fixed-snapshot' };
}
function metadataObservation(value: unknown, scope: ResolvedWechatScope, schema: WechatSchemaInspection, kind: HistoryRecord['kind']): WechatMessageMetadataObservation {
  const row = object(value, ['format', 'status', 'scopeDigest', 'sourceGeneration', 'schemaFingerprint', 'kind', 'checkedPartitions', 'record']);
  if (row.format !== 'wechat-message-metadata-observation-v1' || row.status !== 'unverified' || row.kind !== kind
    || hash(row.scopeDigest) !== digest(`${scope.accountKey}\0${scope.conversationKey}`)
    || row.sourceGeneration !== scope.sourceGeneration || row.schemaFingerprint !== schema.schemaFingerprint) return fail();
  const checkedPartitions = list(row.checkedPartitions, 128, hash, 1); unique(checkedPartitions);
  if (JSON.stringify([...checkedPartitions].sort()) !== JSON.stringify([...schema.checkedPartitions].sort())) return fail();
  const record = row.record === null ? null : metadataRecord(row.record, schema);
  if (record !== null && metadataKind(record.originalType) !== kind) return fail();
  return { format: 'wechat-message-metadata-observation-v1', status: 'unverified', scopeDigest: schema.scopeDigest,
    sourceGeneration: scope.sourceGeneration, schemaFingerprint: schema.schemaFingerprint, kind, checkedPartitions, record };
}
function testMetadataObservation(value: unknown, scope: ResolvedWechatScope, schema: WechatSchemaInspection, action: WechatTestMetadataAction): WechatTestMetadataObservation {
  const row = object(value, ['format', 'status', 'scopeDigest', 'sourceGeneration', 'schemaFingerprint', 'action', 'checkedPartitions', 'lockedCount', 'records']);
  if (row.format !== 'wechat-test-metadata-observation-v1' || row.status !== 'unverified' || row.action !== action) return fail();
  if (hash(row.scopeDigest) !== digest(`${scope.accountKey}\0${scope.conversationKey}`) || hash(row.sourceGeneration) !== scope.sourceGeneration) return fail('history_source_changed');
  if (hash(row.schemaFingerprint) !== schema.schemaFingerprint) return fail('history_schema_changed');
  const checkedPartitions = list(row.checkedPartitions, 128, hash, 1); unique(checkedPartitions);
  if (JSON.stringify([...checkedPartitions].sort()) !== JSON.stringify([...schema.checkedPartitions].sort())) return fail('history_source_changed');
  const lockedCount = integer(row.lockedCount, 2), records = list(row.records, 2, value => value === null ? null : metadataRecord(value, schema));
  if (records.length !== lockedCount) return fail();
  return { format: 'wechat-test-metadata-observation-v1', status: 'unverified', scopeDigest: schema.scopeDigest,
    sourceGeneration: scope.sourceGeneration, schemaFingerprint: schema.schemaFingerprint, action, checkedPartitions, lockedCount, records };
}
interface TestMetadataState { scopeDigest: string; sourceGeneration: string; schemaFingerprint: string; identities: string[] }
function metadataIdentity(record: WechatMessageMetadataRecord): string { return JSON.stringify([record.partition, record.table, record.localId]); }
function signalValid(signal?: AbortSignal): void {
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('history_request_invalid');
}
async function artifactBytes(file: string, maximum: number): Promise<Buffer> {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || await realpath(file) !== file) return fail('history_artifact_unverified');
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) return fail('history_artifact_unverified');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return fail('history_artifact_unverified');
    const bytes = await handle.readFile(); const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) return fail('history_artifact_unverified');
    return bytes;
  } finally { await handle.close(); }
}
async function verifyArtifacts(options: NarrowWechatClientOptions): Promise<void> {
  try {
    const executable = options.executable;
    if (typeof executable !== 'string' || !hashPattern.test(options.expectedCliSha256) || !hashPattern.test(options.expectedWcdbSha256)) fail('history_artifact_unverified');
    const root = path.dirname(path.dirname(executable));
    const cli = await artifactBytes(executable, 128 * 1024 * 1024);
    const wcdb = await artifactBytes(path.join(root, 'lib', 'libWCDB.dylib'), 128 * 1024 * 1024);
    const manifestBytes = await artifactBytes(path.join(root, 'manifest.json'), 64 * 1024);
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)) as Record<string, unknown>;
    if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object'
      || manifest.formatVersion !== 1 || manifest.kind !== 'notalone-history-cli-development' || manifest.architecture !== process.arch
      || manifest.sourceCommit !== '795071fa0591da5fc2c6ab94a70f22ccd93ef06c' || manifest.sourceTree !== '5d617ff3250c27fd9b33a60cb0182e153c521057'
      || manifest.readonlyPatchSha256 !== 'c143ef47728d32c5e647196c75efc33278b49647bd35f3f058b51aeb92ce06aa'
      || manifest.signing !== 'ad-hoc-development' || manifest.realWechatVerified !== false
      || manifest.cliSha256 !== options.expectedCliSha256 || manifest.wcdbSha256 !== options.expectedWcdbSha256
      || digest(cli) !== options.expectedCliSha256 || digest(wcdb) !== options.expectedWcdbSha256) fail('history_artifact_unverified');
  } catch { fail('history_artifact_unverified'); }
}
function validatedOptions(options: NarrowWechatClientOptions): NarrowWechatClientOptions {
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['executable', 'expectedCliSha256', 'expectedWcdbSha256', 'environment'].includes(key))
      || typeof options.executable !== 'string' || typeof options.expectedCliSha256 !== 'string' || typeof options.expectedWcdbSha256 !== 'string') fail('history_request_invalid');
    if (options.environment !== undefined && (!options.environment || typeof options.environment !== 'object' || Array.isArray(options.environment)
      || Object.entries(options.environment).some(([key, value]) => !key.length || /[=\u0000]/.test(key) || value !== undefined && (typeof value !== 'string' || value.includes('\0'))))) fail('history_request_invalid');
    return { ...options, ...(options.environment ? { environment: { ...options.environment } } : {}) };
  } catch { return fail('history_request_invalid'); }
}
interface NativeProcess { child: ChildProcessWithoutNullStreams; exited: Promise<void>; output: Buffer; stderrBytes: number }
interface PendingResponse { limit: number; parse(value: unknown): unknown; resolve(value: unknown): void; reject(error: StorageFailure): void }
/** 只提供已选目标的固定协议；正文分页另需当前支持认证，不提供通用命令、SQL或路径RPC。 */
export class NarrowWechatClient {
  readonly #options: NarrowWechatClientOptions;
  #queue: Promise<void> = Promise.resolve();
  #native?: NativeProcess;
  #selected?: ResolvedWechatScope;
  #account?: WechatAccountMetadata;
  #schema?: WechatSchemaInspection;
  #support?: HistorySupportReport;
  #target?: HistoryTarget;
  #testMetadata?: TestMetadataState;
  #pending?: PendingResponse;
  #stopped = false;
  #failureCode = 'history_native_closed';
  #stopping?: Promise<void>;
  constructor(options: NarrowWechatClientOptions) { this.#options = validatedOptions(options); }
  inspectAccountSchema(signal?: AbortSignal): Promise<WechatAccountSchema> {
    try { signalValid(signal); } catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(() => this.#request({op:'inspect-account-schema',consent:'account-schema-v1'}, value => {
      const parsed = accountSchema(value);
      if (this.#selected && (parsed.accountKey !== this.#selected.accountKey || parsed.sourceGeneration !== this.#selected.sourceGeneration)
        || this.#account && (parsed.accountKey !== this.#account.accountKey || parsed.sourceGeneration !== this.#account.sourceGeneration)) fail('history_scope_changed');
      return parsed;
    }), signal);
  }
  accountMetadata(signal?: AbortSignal): Promise<WechatAccountMetadata> {
    try { signalValid(signal); } catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(() => this.#request({op:'metadata-account',consent:'account-session-metadata-v1'}, value => {
      const parsed = accountMetadata(value, this.#options);
      if (this.#account && JSON.stringify(parsed) !== JSON.stringify(this.#account)
        || this.#selected && (parsed.accountKey !== this.#selected.accountKey || parsed.sourceGeneration !== this.#selected.sourceGeneration)) fail('history_scope_changed');
      this.#account = structuredClone(parsed); return parsed;
    }), signal);
  }
  privateSessionMetadata(evidence: WechatAccountMetadata, signal?: AbortSignal): Promise<WechatPrivateSessionMetadata> {
    try { signalValid(signal); accountMetadata(evidence, this.#options); }
    catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(() => {
      if (!this.#account || JSON.stringify(evidence) !== JSON.stringify(this.#account)) return fail('history_scope_unverified');
      if (this.#account.status !== 'verified') return fail('history_metadata_profile_unverified');
      const account = this.#account;
      return this.#request({op:'metadata-sessions',account:account.accountKey,consent:'private-session-list-metadata-v1'}, value => privateSessionMetadata(value, account, this.#options), 4 * 1024 * 1024);
    }, signal);
  }
  resolveSelected(name: string, signal?: AbortSignal): Promise<ResolvedWechatScope> {
    try { signalValid(signal); if (typeof name !== 'string' || !name.length || Buffer.byteLength(name, 'utf8') > 255 || /[\u0000\r\n]/.test(name)) fail('history_request_invalid'); }
    catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(async () => {
      const scope = await this.#request({ op: 'resolve', displayName: name, consent: 'selected-metadata-v1' }, value => {
        const parsed = resolved(value);
        if (this.#account && (parsed.accountKey !== this.#account.accountKey || parsed.sourceGeneration !== this.#account.sourceGeneration)) return fail('history_scope_changed');
        return parsed;
      });
      this.#selected = { ...scope }; this.#schema = undefined; this.#support = undefined; this.#target = undefined; return scope;
    }, signal);
  }
  inspectSelected(signal?: AbortSignal): Promise<WechatSchemaInspection> {
    try { signalValid(signal); } catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(async () => {
      const scope = this.#selected;
      if (!scope) return fail('history_scope_unverified');
      return this.#request({ op: 'inspect', account: scope.accountKey, conversation: scope.conversationKey, consent: 'selected-schema-v1' }, value => {
        const parsed = inspection(value, scope);
        if (this.#schema && this.#schema.schemaFingerprint !== parsed.schemaFingerprint || this.#support && this.#support.schemaFingerprint !== parsed.schemaFingerprint) fail('history_support_changed');
        this.#schema = structuredClone(parsed); return parsed;
      });
    }, signal);
  }
  observeMetadataSelected(kind: HistoryRecord['kind'], signal?: AbortSignal): Promise<WechatMessageMetadataObservation> {
    try { signalValid(signal); if (!['text', 'image', 'voice', 'video', 'file', 'sticker', 'other'].includes(kind)) fail('history_request_invalid'); }
    catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(async () => {
      const scope = this.#selected, schema = this.#schema;
      if (!scope || !schema) return fail('history_scope_unverified');
      return this.#request({ op: 'observe-metadata', account: scope.accountKey, conversation: scope.conversationKey,
        consent: 'selected-message-metadata-v1', kind }, value => metadataObservation(value, scope, schema, kind));
    }, signal);
  }
  observeTestMetadataSelected(action: WechatTestMetadataAction, signal?: AbortSignal): Promise<WechatTestMetadataObservation> {
    try { signalValid(signal); if (!['arm', 'next', 'current'].includes(action)) fail('history_request_invalid'); }
    catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(async () => {
      const scope = this.#selected, schema = this.#schema, previous = this.#testMetadata;
      if (!scope || !schema) return fail('history_scope_unverified');
      if (action === 'arm' && previous) return fail('history_request_invalid');
      if (action !== 'arm' && !previous) return fail('history_snapshot_closed');
      if (previous && (previous.scopeDigest !== schema.scopeDigest || previous.sourceGeneration !== scope.sourceGeneration)) {
        await this.#stop('history_source_changed'); return fail('history_source_changed');
      }
      if (previous && previous.schemaFingerprint !== schema.schemaFingerprint) {
        await this.#stop('history_schema_changed'); return fail('history_schema_changed');
      }
      return this.#request({ op: 'observe-test-metadata', account: scope.accountKey, conversation: scope.conversationKey,
        consent: 'selected-test-lifecycle-metadata-v1', kind: action }, value => {
        const parsed = testMetadataObservation(value, scope, schema, action), identities = [...(previous?.identities ?? [])];
        if (action === 'arm' ? parsed.lockedCount !== 0 : parsed.lockedCount < identities.length
          || parsed.lockedCount > identities.length + (action === 'next' ? 1 : 0)) return fail('history_identity_ambiguous');
        parsed.records.forEach((record, index) => {
          if (index < identities.length) {
            if (record !== null && metadataIdentity(record) !== identities[index]) fail('history_identity_ambiguous');
          } else {
            if (record === null || record.localId === null || record.sender !== 'owner' || metadataKind(record.originalType) !== 'text') return fail('history_identity_ambiguous');
            const identity = metadataIdentity(record);
            if (identities.includes(identity)) fail('history_identity_ambiguous');
            identities.push(identity);
          }
        });
        this.#testMetadata = { scopeDigest: parsed.scopeDigest, sourceGeneration: parsed.sourceGeneration, schemaFingerprint: parsed.schemaFingerprint, identities };
        return parsed;
      });
    }, signal);
  }
  supportSelected(signal?: AbortSignal): Promise<HistorySupportReport> {
    try { signalValid(signal); } catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(async () => {
      const scope = this.#selected;
      if (!scope) return fail('history_scope_unverified');
      return this.#request({ op: 'support', account: scope.accountKey, conversation: scope.conversationKey, consent: 'selected-schema-v1' }, value => {
        const parsed = supportReport(value, scope, this.#options.expectedCliSha256);
        if (parsed.status === 'supported' && this.#schema && this.#schema.tables.some(table => JSON.stringify(table.declaredPrimaryKey) !== JSON.stringify(parsed.declaredPrimaryKey))) fail();
        if (this.#schema && parsed.schemaFingerprint !== this.#schema.schemaFingerprint
          || this.#support && parsed.schemaFingerprint !== this.#support.schemaFingerprint
          || this.#support?.status === 'supported' && parsed.status === 'supported' && JSON.stringify(parsed) !== JSON.stringify(this.#support)) fail('history_support_changed');
        if (parsed.status !== 'supported') this.#target = undefined;
        this.#support = structuredClone(parsed); return parsed;
      });
    }, signal);
  }
  targetSelected(signal?: AbortSignal): Promise<HistoryTarget> {
    try { signalValid(signal); } catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(async () => {
      const scope = this.#readableScope();
      return this.#request({ op: 'target', account: scope.accountKey, conversation: scope.conversationKey, consent: 'selected-history-v1' }, value => {
        const parsed = historyTarget(value, scope, this.#schema); this.#target = structuredClone(parsed); return parsed;
      });
    }, signal);
  }
  pageSelected(target: HistoryTarget, cursor: string | null, signal?: AbortSignal): Promise<HistoryPage> {
    try { signalValid(signal); if (cursor !== null) opaque(cursor); }
    catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(async () => {
      const scope = this.#readableScope();
      let parsed: HistoryTarget;
      try { parsed = historyTarget(target, scope, this.#schema); } catch { return fail('history_target_unverified'); }
      if (!this.#target || JSON.stringify(parsed) !== JSON.stringify(this.#target)) return fail('history_target_unverified');
      const accepted = this.#target;
      return this.#request({ op: 'page', account: scope.accountKey, conversation: scope.conversationKey, consent: 'selected-history-v1', target: accepted.descriptor, cursor: cursor ?? '' }, value => historyPage(value, accepted, cursor), pageResponseLimit);
    }, signal);
  }
  #readableScope(): ResolvedWechatScope {
    if (!this.#selected) return fail('history_scope_unverified');
    if (this.#support?.status === 'unsupported') return fail('history_support_unsupported');
    if (this.#support?.status !== 'supported') return fail('history_support_unverified');
    return this.#selected;
  }
  #enqueue<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new StorageFailure('history_native_cancelled'));
    const abort = () => { void this.#stop('history_native_cancelled'); };
    signal?.addEventListener('abort', abort, { once: true });
    const operation = this.#queue.then(async () => {
      if (this.#stopped) return fail(this.#failureCode);
      if (signal?.aborted) return fail('history_native_cancelled');
      const timer = setTimeout(() => { void this.#stop('history_native_timeout'); }, 10_000);
      try { return await work(); }
      catch (error) {
        if (error instanceof StorageFailure && allowedErrors.has(error.code)) throw error;
        return fail('history_native_unavailable');
      } finally { clearTimeout(timer); }
    }).finally(() => signal?.removeEventListener('abort', abort));
    this.#queue = operation.then(() => {}, () => {});
    return operation;
  }
  async #start(): Promise<NativeProcess> {
    if (this.#stopped) return fail(this.#failureCode);
    if (this.#native) return this.#native;
    await verifyArtifacts(this.#options);
    if (this.#stopped) return fail(this.#failureCode);
    const environment = this.#options.environment ?? Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    const child = spawn(this.#options.executable, ['notalone-history'], { stdio: ['pipe', 'pipe', 'pipe'], env: environment, shell: false });
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    const native: NativeProcess = { child, exited, output: Buffer.alloc(0), stderrBytes: 0 };
    this.#native = native;
    child.once('error', () => { void this.#stop('history_native_unavailable'); });
    child.once('close', () => { if (!this.#stopped) void this.#stop('history_native_unavailable'); });
    child.stdin.on('error', () => { void this.#stop('history_native_unavailable'); });
    child.stdout.on('error', () => { void this.#stop('history_native_unavailable'); });
    child.stderr.on('error', () => { void this.#stop('history_native_unavailable'); });
    child.stdout.on('data', (chunk: Buffer) => this.#output(native, chunk));
    child.stdout.once('end', () => { if (!this.#stopped) void this.#stop('history_native_unavailable'); });
    child.stderr.on('data', (chunk: Buffer) => {
      native.stderrBytes += chunk.length;
      if (native.stderrBytes > stderrLimit) void this.#stop('history_stderr_limit');
    });
    return native;
  }
  async #request<T>(request: Record<string, string>, parse: (value: unknown) => T, limit = responseLimit): Promise<T> {
    let native: NativeProcess;
    try { native = await this.#start(); }
    catch (error) { const code = error instanceof StorageFailure ? error.code : 'history_native_unavailable'; await this.#stop(code); return fail(code); }
    if (this.#stopped) return fail(this.#failureCode);
    return new Promise<T>((resolve, reject) => {
      this.#pending = { limit, parse, resolve: value => resolve(value as T), reject };
      try { native.child.stdin.write(`${JSON.stringify(request)}\n`, error => { if (error) void this.#stop('history_native_unavailable'); }); }
      catch { void this.#stop('history_native_unavailable'); }
    });
  }
  #output(native: NativeProcess, chunk: Buffer): void {
    if (this.#stopped) return;
    const pending = this.#pending;
    if (!pending) { void this.#stop('history_protocol_invalid'); return; }
    if (native.output.length + chunk.length > pending.limit + 1) { void this.#stop('history_response_too_large'); return; }
    native.output = Buffer.concat([native.output, chunk]);
    const end = native.output.indexOf(10);
    if (end < 0) {
      if (native.output.length > pending.limit) void this.#stop('history_response_too_large');
      return;
    }
    if (end > pending.limit) { void this.#stop('history_response_too_large'); return; }
    if (end !== native.output.length - 1) { void this.#stop('history_protocol_invalid'); return; }
    try {
      const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(native.output.subarray(0, end))) as unknown;
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return fail();
      const success = (envelope as Record<string, unknown>).ok;
      if (success === false) {
        const row = object(envelope, ['ok', 'error']); const error = object(row.error, ['code']);
        const code = typeof error.code === 'string' && allowedErrors.has(error.code) ? error.code : 'history_protocol_invalid';
        void this.#stop(code); return;
      }
      if (success !== true) return fail();
      const row = object(envelope, ['ok', 'data']); const value = pending.parse(row.data);
      native.output = Buffer.alloc(0); this.#pending = undefined; pending.resolve(value);
    } catch (error) { void this.#stop(error instanceof StorageFailure && allowedErrors.has(error.code) ? error.code : 'history_protocol_invalid'); }
  }
  async #stop(code: string): Promise<void> {
    if (this.#stopped) { await this.#stopping; return; }
    this.#stopped = true; this.#failureCode = allowedErrors.has(code) ? code : 'history_native_unavailable'; this.#selected = undefined; this.#account = undefined; this.#schema = undefined; this.#support = undefined; this.#target = undefined; this.#testMetadata = undefined;
    const pending = this.#pending; this.#pending = undefined;
    this.#stopping = (async () => {
      const native = this.#native;
      if (native) { native.child.kill('SIGKILL'); await native.exited; native.output = Buffer.alloc(0); }
      this.#native = undefined;
    })();
    await this.#stopping;
    pending?.reject(new StorageFailure(this.#failureCode));
  }
  async close(): Promise<void> { await this.#stop('history_native_closed'); await this.#queue; }
}
