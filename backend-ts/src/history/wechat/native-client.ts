import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import type { HistoryPage, HistoryRecord, HistorySupportReport, HistoryTarget, HistoryTailPage } from '../sqlite/contracts.ts';
import { boundaryProtocol, maxBoundaryMembers, membersManifestSha256, sourceLocalKey, type HistoryBoundaryCandidate } from '../sqlite/boundary.ts';
import { isPartitionGrowthTargetChange, isSafePartitionGrowth, historyTargetTransition } from '../partition-growth.ts';

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
/** 一次已经关闭的固定快照核验记录，不授予后续快照或正文读取资格。 */
export interface WechatFixedSnapshotProof {
  format: 'wechat-history-fixed-snapshot-proof-v1'; status: 'verified';
  scopeDigest: string; sourceGeneration: string; schemaFingerprint: string;
  expectedPartitionCount: number; completedPartitionCount: number;
  namespaceContinuity: true; instanceContinuity: true; snapshotBarrier: true;
  scope: 'single-fixed-snapshot'; authorizesSubsequentRead: false;
  partitions: {partition:string;tablePresent:boolean;instance:string|null;preSample:string;postSample:string;readerPinned:true;sourceInstanceHeld:true}[];
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
export interface WechatReceivedTestMetadataObservation {
  format: 'wechat-received-test-metadata-observation-v1'; status: 'unverified'; scopeDigest: string;
  sourceGeneration: string; schemaFingerprint: string; action: WechatTestMetadataAction;
  checkedPartitions: string[]; lockedCount: number; records: (WechatMessageMetadataRecord | null)[];
}
export interface NarrowWechatClientOptions {
  executable: string; expectedCliSha256: string; expectedWcdbSha256: string;
  environment?: Record<string, string | undefined>;
}
export interface WechatImageSourceIdentity {
  partition: string; table: string; localId: string; serverId: string; sentAt: string;
}
export interface WechatImageQualityProofV1 {
  kind: 'wechat-cdn-big-hd-exact-content-v1'; messageMd5: string; hdLength: number; hdWidth: number; hdHeight: number;
  bigImageUrlPresent: true; resourceSize: number; verifiedBytes: number; verifiedSha256: string;
}
export interface WechatImageQualityProofV2 {
  kind: 'wechat-cdn-big-hd-exact-content-v2'; messageMd5: string; hdLength: number; hdWidth: number | null; hdHeight: number | null;
  bigImageUrlPresent: true; resourceSize: number; verifiedBytes: number; verifiedSha256: string;
  contentWidth: number; contentHeight: number;
}
export interface WechatImageQualityProofV3 {
  kind: 'wechat-cdn-big-hd-exact-content-v3'; messageMd5: string; hdLength: number; hdWidth: number | null; hdHeight: number | null;
  bigImageUrlPresent: true; resourceSize: number; verifiedBytes: number; verifiedSha256: string;
  contentWidth: number; contentHeight: number; resourceInfoId: string; matchingResourceIds: string[];
}
export type WechatImageQualityProof = WechatImageQualityProofV1 | WechatImageQualityProofV2 | WechatImageQualityProofV3;
export interface WechatImageOpenResult {
  protocol: 'wechat-original-image-v1'; resourceToken: string; sourceGeneration: string; resourceSourceGeneration: string;
  target: string; partition: string; table: string; localId: string; serverId: string; sentAt: string;
  resourceTable: 'wechat-message-resource-v1'; resourceId: string;
  resourceTypeRaw: number; variantCode: number; complete: true; quality: 'original'; qualityProof: WechatImageQualityProof;
  expectedBytes: number; expectedSha256: string; mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/bmp';
  envelope: 'plain'; sourceEnvelope: 'plain' | 'wechat_dat';
}
export interface WechatImageReadResult {
  resourceToken: string; sourceGeneration: string; offset: number; bytesRead: number; totalBytes: number;
  chunkBase64: string; eof: boolean; verifiedSha256?: string;
}
const responseLimit = 2 * 1024 * 1024;
const pageResponseLimit = 8 * 1024 * 1024;
const boundaryResponseLimit = 32 * 1024 * 1024;
// 16×65536×最坏6倍JSON转义为6MiB，为有界元数据及游标保留2MiB。
const pageRecordLimit = 16;
const stderrLimit = 64 * 1024;
const digest = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
const fail = (code = 'history_protocol_invalid'): never => { throw new StorageFailure(code); };
const hashPattern = /^[a-f0-9]{64}$/;
const absentPrivateTargetProfile = 'wechat-4.0.6-29387-absent-private-target-v1';
// 系统会话不代表用户的真实关系对象，也不能成为单联系人读取目标。
const systemConversations = new Set(['filehelper', 'notifymessage']);
const allowedErrors = new Set([
  'history_target_growth_required',
  'history_checkpoint_invalid', 'history_checkpoint_too_large', 'history_checkpoint_unavailable',
  'history_delta_btree_cell_invalid', 'history_delta_btree_cells_invalid', 'history_delta_btree_child_invalid',
  'history_delta_btree_child_missing', 'history_delta_btree_cycle', 'history_delta_btree_duplicate_rowid',
  'history_delta_btree_header_invalid', 'history_delta_btree_kind_invalid', 'history_delta_btree_page_invalid',
  'history_delta_btree_payload_invalid', 'history_delta_btree_reserve_invalid', 'history_delta_btree_rightmost_invalid',
  'history_delta_checkpoint_invalid', 'history_delta_cipher_hmac_invalid', 'history_delta_cipher_layout_invalid',
  'history_delta_cipher_page_invalid', 'history_delta_cipher_salt_mismatch', 'history_delta_cipher_unavailable',
  'history_delta_key_unavailable', 'history_delta_new_child_frame_missing', 'history_delta_new_child_kind_invalid',
  'history_delta_new_overflow_frame_missing', 'history_delta_overflow_cycle', 'history_delta_overflow_header_invalid',
  'history_delta_overflow_leaf_missing', 'history_delta_overflow_length_mismatch', 'history_delta_overflow_link_invalid',
  'history_delta_overflow_owner_missing', 'history_delta_overflow_page_missing', 'history_delta_overflow_pointer_invalid',
  'history_delta_overflow_shared', 'history_delta_page_count_invalid', 'history_delta_page_invalid',
  'history_delta_page_missing', 'history_delta_plain_header_invalid', 'history_delta_plain_reserve_invalid',
  'history_delta_read_invalid', 'history_delta_request_invalid', 'history_delta_root_missing',
  'history_delta_salt_invalid', 'history_delta_short_read', 'history_delta_source_limit',
  'history_delta_source_unavailable', 'history_delta_tree_empty', 'history_delta_tree_page_kind_invalid',
  'history_delta_varint_bounds', 'history_delta_varint_truncated', 'history_delta_wal_checksum_length',
  'history_delta_wal_database_size_invalid', 'history_delta_wal_frame_checksum_invalid', 'history_delta_wal_frame_header_invalid',
  'history_delta_wal_frame_limit', 'history_delta_wal_frame_missing', 'history_delta_wal_header_checksum_invalid',
  'history_delta_wal_header_invalid', 'history_delta_wal_magic_invalid', 'history_delta_wal_page_size_invalid',
  'history_delta_wal_version_invalid',
  'history_delta_wal_index_invalid',
  'history_metadata_profile_unverified', 'history_program_version_uncertified',
  'history_request_invalid', 'history_operation_unsupported', 'history_scope_unverified',
  'history_image_association_unverified', 'history_image_original_unavailable', 'history_image_source_changed',
  'history_image_resource_invalid', 'history_image_token_invalid', 'history_image_offset_invalid',
  'history_image_too_large', 'history_image_read_failed', 'history_image_request_invalid',
  'history_image_metadata_invalid', 'history_image_local_file_missing', 'history_image_key_unavailable', 'history_image_quality_unverified',
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
  'history_snapshot_window_changed', 'history_snapshot_proof_incomplete', 'history_text_unknown', 'history_text_invalid',
  'history_test_sender_unverified', 'history_test_sender_ambiguous', 'history_test_new_rows_ambiguous',
  'history_test_type_unverified', 'history_test_key_unverified',
  'history_tail_unsupported', 'history_tail_baseline_too_large', 'history_boundary_unsupported', 'history_boundary_candidate_too_large',
  'history_boundary_scope_invalid', 'history_boundary_support_unverified', 'history_boundary_candidate_incomplete',
  'history_boundary_member_limit', 'history_boundary_member_invalid', 'history_boundary_read_failed',
  'history_boundary_instance_changed', 'history_snapshot_close_failed',
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
function imageToken(value: unknown): string {
  const parsed=text(value,128);
  return /^[A-Za-z0-9_.:-]{16,128}$/.test(parsed)?parsed:fail('history_image_token_invalid');
}
function imageIdentity(value: WechatImageSourceIdentity): WechatImageSourceIdentity {
  if(!value||typeof value!=='object'||Object.keys(value).length!==5||!['partition','table','localId','serverId','sentAt'].every(key=>Object.hasOwn(value,key)))return fail('history_image_request_invalid');
  const partition=hash(value.partition),table=hash(value.table),localId=exactInteger(value.localId),serverId=exactInteger(value.serverId),sentAt=unsigned(value.sentAt);
  return {partition,table,localId,serverId,sentAt};
}
function imageResourceId(value: unknown): string {
  const id=unsigned(value);
  return BigInt(id)>0n?id:fail('history_image_quality_unverified');
}
function imageQualityProof(value: unknown, expectedBytes: number, expectedSha256: string, representativeId:string): WechatImageQualityProof {
  try{
    if(!value||typeof value!=='object'||Array.isArray(value))return fail('history_image_quality_unverified');
    const kind=(value as Record<string,unknown>).kind;
    const proofRow=kind==='wechat-cdn-big-hd-exact-content-v1'
      ?object(value,['kind','messageMd5','hdLength','hdWidth','hdHeight','bigImageUrlPresent','resourceSize','verifiedBytes','verifiedSha256'])
      :kind==='wechat-cdn-big-hd-exact-content-v2'
        ?object(value,['kind','messageMd5','hdLength','hdWidth','hdHeight','bigImageUrlPresent','resourceSize','verifiedBytes','verifiedSha256','contentWidth','contentHeight'])
        :kind==='wechat-cdn-big-hd-exact-content-v3'
          ?object(value,['kind','messageMd5','hdLength','hdWidth','hdHeight','bigImageUrlPresent','resourceSize','verifiedBytes','verifiedSha256','contentWidth','contentHeight','resourceInfoId','matchingResourceIds'])
          :fail('history_image_quality_unverified');
    const messageMd5=text(proofRow.messageMd5,32),hdLength=integer(proofRow.hdLength,32*1024*1024);
    const resourceSize=integer(proofRow.resourceSize,kind==='wechat-cdn-big-hd-exact-content-v3'?64*1024*1024:32*1024*1024);
    const verifiedBytes=integer(proofRow.verifiedBytes,32*1024*1024),verifiedSha256=hash(proofRow.verifiedSha256);
    if(!/^[a-f0-9]{32}$/.test(messageMd5)||!hdLength||hdLength!==expectedBytes||proofRow.bigImageUrlPresent!==true||!resourceSize
      ||kind!=='wechat-cdn-big-hd-exact-content-v3'&&resourceSize!==expectedBytes
      ||verifiedBytes!==expectedBytes||verifiedSha256!==expectedSha256)return fail('history_image_quality_unverified');
    if(kind==='wechat-cdn-big-hd-exact-content-v1'){
      const hdWidth=integer(proofRow.hdWidth,1_000_000),hdHeight=integer(proofRow.hdHeight,1_000_000);
      if(!hdWidth||!hdHeight)return fail('history_image_quality_unverified');
      return {kind:'wechat-cdn-big-hd-exact-content-v1',messageMd5,hdLength,hdWidth,hdHeight,bigImageUrlPresent:true,resourceSize,verifiedBytes,verifiedSha256};
    }
    const dimension=(input:unknown):number|null=>input===null?null:integer(input,100_000);
    const hdWidth=dimension(proofRow.hdWidth),hdHeight=dimension(proofRow.hdHeight);
    const contentWidth=integer(proofRow.contentWidth,100_000),contentHeight=integer(proofRow.contentHeight,100_000);
    if(!contentWidth||!contentHeight||contentWidth*contentHeight>100_000_000
      ||(hdWidth===null)!==(hdHeight===null)
      ||hdWidth!==null&&(!hdWidth||!hdHeight||hdWidth!==contentWidth||hdHeight!==contentHeight))return fail('history_image_quality_unverified');
    if(kind==='wechat-cdn-big-hd-exact-content-v2')
      return {kind:'wechat-cdn-big-hd-exact-content-v2',messageMd5,hdLength,hdWidth,hdHeight,bigImageUrlPresent:true,resourceSize,verifiedBytes,verifiedSha256,contentWidth,contentHeight};
    const resourceInfoId=imageResourceId(proofRow.resourceInfoId),matchingResourceIds=list(proofRow.matchingResourceIds,32,imageResourceId,1);
    if(matchingResourceIds.some((id,index)=>index>0&&BigInt(matchingResourceIds[index-1])>=BigInt(id))||matchingResourceIds[0]!==representativeId)
      return fail('history_image_quality_unverified');
    return {kind:'wechat-cdn-big-hd-exact-content-v3',messageMd5,hdLength,hdWidth,hdHeight,bigImageUrlPresent:true,resourceSize,verifiedBytes,verifiedSha256,contentWidth,contentHeight,
      resourceInfoId,matchingResourceIds};
  }catch{return fail('history_image_quality_unverified');}
}
function imageOpen(value: unknown, scope: ResolvedWechatScope, target: HistoryTarget, source: WechatImageSourceIdentity, expectedBytesMaximum:number): WechatImageOpenResult {
  const row=object(value,['protocol','resourceToken','sourceGeneration','resourceSourceGeneration','target','partition','table','localId','serverId','sentAt',
    'resourceTable','resourceId','resourceTypeRaw','variantCode','complete','quality','qualityProof','expectedBytes','expectedSha256','mimeType','envelope','sourceEnvelope']);
  const expectedBytes=integer(row.expectedBytes,Number.MAX_SAFE_INTEGER),expectedSha256=hash(row.expectedSha256);
  if(expectedBytes>expectedBytesMaximum)return fail('history_image_too_large');
  if(expectedBytes<1)return fail('history_image_resource_invalid');
  const mimeType=row.mimeType;
  if(row.protocol!=='wechat-original-image-v1'||scope.sourceGeneration!==target.sourceGeneration)return fail('history_image_association_unverified');
  if(row.sourceGeneration!==scope.sourceGeneration)return fail('history_image_source_changed');
  if(row.target!==target.descriptor||row.partition!==source.partition||row.table!==source.table||row.localId!==source.localId||row.serverId!==source.serverId||row.sentAt!==source.sentAt
    ||!target.tables.some(item=>item.partition===source.partition&&item.instance===source.table))return fail('history_image_association_unverified');
  if(row.complete!==true||row.quality!=='original')return fail('history_image_original_unavailable');
  if(row.resourceTable!=='wechat-message-resource-v1'
    ||row.envelope!=='plain'||row.sourceEnvelope!=='plain'&&row.sourceEnvelope!=='wechat_dat'
    ||typeof mimeType!=='string'||!['image/jpeg','image/png','image/gif','image/bmp'].includes(mimeType))return fail('history_image_resource_invalid');
  const resourceId=unsigned(row.resourceId),qualityProof=imageQualityProof(row.qualityProof,expectedBytes,expectedSha256,resourceId);
  return {protocol:'wechat-original-image-v1',resourceToken:imageToken(row.resourceToken),sourceGeneration:scope.sourceGeneration,
    resourceSourceGeneration:hash(row.resourceSourceGeneration),target:target.descriptor,partition:source.partition,table:source.table,
    localId:source.localId,serverId:source.serverId,sentAt:source.sentAt,resourceTable:row.resourceTable as WechatImageOpenResult['resourceTable'],
    resourceId,resourceTypeRaw:integer(row.resourceTypeRaw,0x7fffffff),variantCode:integer(row.variantCode,0x7fffffff),
    complete:true,quality:'original',qualityProof,expectedBytes,expectedSha256,mimeType:mimeType as WechatImageOpenResult['mimeType'],
    envelope:'plain',sourceEnvelope:row.sourceEnvelope as WechatImageOpenResult['sourceEnvelope']};
}
function imageRead(value: unknown, active:{token:string;sourceGeneration:string;expectedBytes:number;expectedSha256:string;nextOffset:number}, requestedOffset:number):WechatImageReadResult {
  const hasHash=!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.hasOwn(value,'verifiedSha256');
  const row=object(value,['resourceToken','sourceGeneration','offset','bytesRead','totalBytes','chunkBase64','eof',...(hasHash?['verifiedSha256']:[])]);
  const offset=integer(row.offset,active.expectedBytes),bytesRead=integer(row.bytesRead,65536),totalBytes=integer(row.totalBytes,32*1024*1024);
  const chunkBase64=text(row.chunkBase64,90_000),eof=bool(row.eof);
  if(row.resourceToken!==active.token)return fail('history_image_token_invalid');
  if(row.sourceGeneration!==active.sourceGeneration||totalBytes!==active.expectedBytes)return fail('history_image_source_changed');
  if(offset!==requestedOffset||offset!==active.nextOffset)return fail('history_image_offset_invalid');
  if(bytesRead<1||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunkBase64))return fail('history_image_read_failed');
  const chunk=Buffer.from(chunkBase64,'base64');
  if(chunk.toString('base64')!==chunkBase64||chunk.length!==bytesRead||offset+bytesRead>totalBytes
    ||eof!==(offset+bytesRead===totalBytes)||hasHash!==eof||hasHash&&hash(row.verifiedSha256)!==active.expectedSha256)return fail('history_image_read_failed');
  active.nextOffset+=bytesRead;
  return {resourceToken:active.token,sourceGeneration:active.sourceGeneration,offset,bytesRead,totalBytes,chunkBase64,eof,...(hasHash?{verifiedSha256:active.expectedSha256}:{})};
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
  if (systemConversations.has(conversationKey)) return fail('history_target_not_private');
  return { accountKey, conversationKey, displayName: metadataDisplayName(row.displayName, conversationKey), sourceGeneration: hash(row.sourceGeneration) };
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
  const tables = list(row.tables, 128, table); unique(tables.map(item => item.target));
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
function metadataDisplayName(value: unknown, username: string): string {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.length || Buffer.byteLength(value, 'utf8') > 255 || /[\0\r\n]/.test(value)) return fail();
  // 名称只作展示；规整渠道标签中的控制字符，稳定身份仍严格取 username。
  return text(value.replace(/[\u0001-\u001f\u007f-\u009f]/g, ' ').trim() || username);
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
    return {username, displayName: metadataDisplayName(item.displayName, username), kind: 'private' as const, identityAssurance: 'verified' as const};
  });
  unique(sessions.map(item => item.username));
  return {format: 'wechat-private-session-metadata-v1', account, sessions: sessions.filter(item => !systemConversations.has(item.username))};
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
  const absentTarget = row.profileId === absentPrivateTargetProfile && row.programVersion === '4.0.6' && row.build === '29387'
    && row.statusSemantics === 'no-message-table-v1' && row.continuity === 'same-source-instances-normal-use-v1';
  if (row.status === 'supported' && (reason !== null || !declaredPrimaryKey.length && !absentTarget
    || row.profileId === absentPrivateTargetProfile && (!absentTarget || declaredPrimaryKey.length > 0))) return fail();
  let capabilities: Record<string, 'supported' | 'unsupported' | 'unverified'> | undefined;
  if (hasCapabilities) {
    const extras = ['incrementalTail', 'durableIncremental', 'partitionGrowth', boundaryProtocol].filter(key => Object.hasOwn(row.capabilities as object, key));
    const keys = ['programVersion', 'exactSchema', 'declaredLocalKey', 'automaticAllocation', 'serverIdUniqueConstraint', 'statusColumn', 'statusSemantics', 'sourceLifecycle', 'restartContinuity', 'recoveryMapping', 'snapshotBarrier', 'partitionCoverage', 'normalHistory', ...extras];
    const reported = object(row.capabilities, keys);
    capabilities = Object.fromEntries(keys.map(key => {
      const value = reported[key];
      if (value !== 'supported' && value !== 'unsupported' && value !== 'unverified') return fail();
      return [key, value];
    }));
  }
  if (row.status === 'supported' && absentTarget && (!capabilities
    || ['programVersion', 'exactSchema', 'statusSemantics', 'sourceLifecycle', 'restartContinuity', 'recoveryMapping', 'snapshotBarrier', 'partitionCoverage', 'normalHistory'].some(key => capabilities[key] !== 'supported')
    || ['declaredLocalKey', 'automaticAllocation', 'serverIdUniqueConstraint', 'statusColumn', 'incrementalTail'].some(key => capabilities[key] !== 'unsupported'))) return fail();

  return { protocol: 'private-history-v1', profileId: text(row.profileId), adapterVersion: text(row.adapterVersion),
    status: row.status as HistorySupportReport['status'], reason, accountKey: scope.accountKey, conversationKey: scope.conversationKey,
    sourceGeneration: scope.sourceGeneration, programVersion: text(row.programVersion), build: text(row.build), artifactSha256: hash(row.artifactSha256),
    schemaFingerprint: hash(row.schemaFingerprint), declaredPrimaryKey, serverAliasSemantics: 'unverified', identity: 'source-table-local-v1', statusSemantics, continuity, ...(capabilities ? { capabilities } : {}) };
}
function historyTarget(value: unknown, scope: ResolvedWechatScope, schema?: WechatSchemaInspection): HistoryTarget {
  const hasChecked=!!value&&typeof value==='object'&&Object.hasOwn(value,'checkedPartitions');
  const row = object(value, ['protocol', 'descriptor', 'partitions', 'tables', 'sourceGeneration',...(hasChecked?['checkedPartitions']:[])]);
  if (row.protocol !== 'private-history-v1' || row.sourceGeneration !== scope.sourceGeneration) return fail();
  const partitions = list(row.partitions, 128, hash, 1); unique(partitions);
  const tables = list(row.tables, 128, value => {
    const table = object(value, ['partition', 'instance']);
    return { partition: hash(table.partition), instance: hash(table.instance) };
  });
  unique(tables.map(table => table.instance));
  const checkedPartitions=hasChecked?list(row.checkedPartitions,128,hash,1):undefined;
  if(checkedPartitions){unique(checkedPartitions);if(partitions.some(partition=>!checkedPartitions.includes(partition)))return fail();}
  if (tables.some(table => !partitions.includes(table.partition))) return fail();
  if (!tables.length && (!schema || schema.tables.length > 0)) return fail();
  if (schema && (JSON.stringify([...partitions].sort()) !== JSON.stringify([...(schema.tables.length ? new Set(schema.tables.map(table => table.partition)) : schema.checkedPartitions)].sort())
    || JSON.stringify(tables.map(table => `${table.partition}:${table.instance}`).sort()) !== JSON.stringify(schema.tables.map(table => `${table.partition}:${table.target}`).sort()))) return fail();
  if(schema&&checkedPartitions&&JSON.stringify([...checkedPartitions].sort())!==JSON.stringify([...schema.checkedPartitions].sort()))return fail();
  return { protocol: 'private-history-v1', descriptor: opaque(row.descriptor), partitions, tables, sourceGeneration: scope.sourceGeneration,...(checkedPartitions?{checkedPartitions}:{}) };
}
function historyRecord(value: unknown, target: HistoryTarget, mode: 'normal' | 'quarantine' = 'normal'): HistoryRecord {
  const quarantine = mode === 'quarantine';
  const hasMessageState=!!value&&typeof value==='object'&&Object.hasOwn(value,'messageState');
  const hasMetadataOnly=!!value&&typeof value==='object'&&Object.hasOwn(value,'metadataOnly');
  const row = object(value, ['partition', 'table', 'localId', 'serverId', 'sender', 'kind', 'text', 'originalType', 'sentAt', 'timePrecision', 'orderScheme', 'orderKey', 'status', 'stateAssurance',...(hasMessageState?['messageState']:[]),...(hasMetadataOnly?['metadataOnly']:[])]);
  const partition = hash(row.partition), table = hash(row.table);
  if (!target.tables.some(candidate => candidate.partition === partition && candidate.instance === table)
    || !['owner', 'contact', 'unknown'].includes(row.sender as string)
    || !['text', 'image', 'voice', 'video', 'file', 'sticker', 'other'].includes(row.kind as string)
    || !['verified', 'unverified'].includes(row.stateAssurance as string) || quarantine && row.stateAssurance !== 'unverified'
    || !quarantine && row.stateAssurance === 'unverified' && row.text !== null) return fail();
  if(hasMessageState&&(row.stateAssurance!=='verified'||!['sent','received','recalled','absent'].includes(row.messageState as string)
    ||row.messageState==='sent'&&row.sender!=='owner'||row.messageState==='received'&&row.sender!=='contact'
    ||['recalled','absent'].includes(row.messageState as string)&&(row.kind!=='other'||row.text!==null||row.localId===null)))return fail();
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
  const originalType = row.originalType === 'unknown' && row.kind === 'other' ? 'unknown' : exactInteger(row.originalType);
  if(hasMetadataOnly&&(quarantine||row.metadataOnly!==true||row.kind==='text'||row.text!==null||row.stateAssurance!=='unverified'||hasMessageState
    ||originalType==='unknown'||BigInt(originalType)<0n||(BigInt(originalType)&0xffffffffn)===1n||row.kind!==historyMetadataKind(originalType)))return fail();
  if(quarantine && (originalType==='unknown'?'other':historyMetadataKind(originalType))!==row.kind)return fail();
  return { partition, table, localId: row.localId === null ? null : exactInteger(row.localId), serverId: row.serverId === null ? null : exactInteger(row.serverId),
    sender: row.sender as HistoryRecord['sender'], kind: row.kind as HistoryRecord['kind'], text: body, originalType,
    sentAt, timePrecision: row.timePrecision as HistoryRecord['timePrecision'], orderScheme, orderKey, status: row.status === null ? null : exactInteger(row.status), stateAssurance: row.stateAssurance as HistoryRecord['stateAssurance'],...(hasMetadataOnly?{metadataOnly:true as const}:{}),...(hasMessageState?{messageState:row.messageState as HistoryRecord['messageState']}:{}) };
}
function historyMetadataKind(originalType:string):HistoryRecord['kind'] {
  return (BigInt(originalType)&0xffffffffn)===49n ? BigInt(originalType)>>32n===6n?'file':'other' : metadataKind(originalType);
}
function historyPage(value: unknown, target: HistoryTarget, cursor: string | null, mode: 'normal' | 'quarantine' = 'normal'): HistoryPage {
  const hasResume = !!value && typeof value === 'object' && Object.hasOwn(value, 'resumeCursor');
  const row = object(value, ['target', 'cursorIn', 'cursorOut', 'records', 'completedPartitions', 'exhausted', ...(hasResume ? ['resumeCursor'] : [])]);
  if (row.target !== target.descriptor || row.cursorIn !== cursor) return fail();
  const cursorOut = row.cursorOut === null ? null : opaque(row.cursorOut), exhausted = bool(row.exhausted);
  if (exhausted ? cursorOut !== null : cursorOut === null || cursorOut === cursor) return fail();
  const completedPartitions = list(row.completedPartitions, 128, hash); unique(completedPartitions);
  if (completedPartitions.some(partition => !target.partitions.includes(partition))) return fail();
  if (hasResume && (mode !== 'normal' || !exhausted || row.resumeCursor === null)) return fail();
  return { target: target.descriptor, cursorIn: cursor, cursorOut, records: list(row.records, pageRecordLimit, value => historyRecord(value, target, mode)), completedPartitions, exhausted,
    ...(hasResume ? { resumeCursor: opaque(row.resumeCursor) } : {}) };
}
function historyTailPage(value: unknown, target: HistoryTarget, cursor: string): HistoryTailPage {
  const row = object(value, ['target', 'cursorIn', 'cursorOut', 'records', 'caughtUp']);
  const cursorOut = opaque(row.cursorOut);
  if (row.target !== target.descriptor || row.cursorIn !== cursor || cursorOut === cursor) return fail();
  return { target: target.descriptor, cursorIn: cursor, cursorOut, records: list(row.records, pageRecordLimit, value => historyRecord(value, target)), caughtUp: bool(row.caughtUp) };
}
function historyBoundary(value: unknown, scope: ResolvedWechatScope, schema: WechatSchemaInspection, support: HistorySupportReport): HistoryBoundaryCandidate {
  const row = object(value, ['format', 'scopeDigest', 'sourceGeneration', 'schemaFingerprint', 'target', 'boundaryToken', 'members', 'partitions', 'namespaceContinuity', 'instanceContinuity', 'observedAt']);
  if (row.format !== 'wechat-history-boundary-v1' || row.scopeDigest !== schema.scopeDigest || row.sourceGeneration !== scope.sourceGeneration
    || row.schemaFingerprint !== schema.schemaFingerprint || row.namespaceContinuity !== true || row.instanceContinuity !== true) return fail();
  const target = historyTarget(row.target, scope, schema);
  const members = list(row.members, maxBoundaryMembers, value => {
    const member = object(value, ['partition', 'table', 'localId']);
    const partition = hash(member.partition), table = hash(member.table), localId = exactInteger(member.localId, true);
    if (!target.tables.some(item => item.partition === partition && item.instance === table)) return fail();
    return { partition, table, localId };
  });
  const keys = members.map(member => sourceLocalKey(scope.sourceGeneration, member.partition, member.table, member.localId)); unique(keys);
  const counts = new Map<string, number>();
  for (const member of members) counts.set(member.partition, (counts.get(member.partition) ?? 0) + 1);
  const partitions = list(row.partitions, 128, value => {
    const entry = object(value, ['partition', 'instance', 'preSample', 'postSample', 'readerCompleted', 'memberCount']);
    const partition = hash(entry.partition), instance = hash(entry.instance), preSample = opaque(entry.preSample), postSample = opaque(entry.postSample), memberCount = integer(entry.memberCount, maxBoundaryMembers);
    if (preSample !== postSample || entry.readerCompleted !== true || !target.tables.some(item => item.partition === partition && item.instance === instance)
      || (counts.get(partition) ?? 0) !== memberCount) return fail();
    return { partition, instance, preSample, postSample, readerCompleted: true, memberCount };
  });
  unique(partitions.map(entry => entry.partition));
  if (partitions.length !== target.partitions.length) return fail();
  const observedAt = text(row.observedAt, 64); if (!Number.isFinite(Date.parse(observedAt))) return fail();
  const normalized = members.map(member => ({ partition: member.partition, tableInstance: member.table, localKey: sourceLocalKey(scope.sourceGeneration, member.partition, member.table, member.localId) })).sort((a, b) => a.localKey.localeCompare(b.localKey));
  return { protocol: boundaryProtocol, target, support, accountKey: scope.accountKey, conversationKey: scope.conversationKey, sourceGeneration: scope.sourceGeneration,
    boundaryToken: opaque(row.boundaryToken), manifestSha256: membersManifestSha256(target.descriptor, normalized), members, partitions, namespaceContinuity: true, instanceContinuity: true, observedAt };
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
function fixedSnapshotProof(value:unknown,scope:ResolvedWechatScope,schema:WechatSchemaInspection):WechatFixedSnapshotProof{
  const row=object(value,['format','status','scopeDigest','sourceGeneration','schemaFingerprint','expectedPartitionCount','completedPartitionCount',
    'namespaceContinuity','instanceContinuity','snapshotBarrier','scope','authorizesSubsequentRead','partitions']);
  if(row.format!=='wechat-history-fixed-snapshot-proof-v1'||row.status!=='verified'||row.scope!=='single-fixed-snapshot'
    ||row.authorizesSubsequentRead!==false||row.namespaceContinuity!==true||row.instanceContinuity!==true||row.snapshotBarrier!==true
    ||hash(row.scopeDigest)!==schema.scopeDigest||row.sourceGeneration!==scope.sourceGeneration||row.schemaFingerprint!==schema.schemaFingerprint)return fail();
  const partitions=list(row.partitions,128,value=>{
    const part=object(value,['partition','tablePresent','instance','preSample','postSample','readerPinned','sourceInstanceHeld']);
    const partition=hash(part.partition),expected=schema.tables.find(table=>table.partition===partition);
    const preSample=unsigned(part.preSample),postSample=unsigned(part.postSample);
    if(!schema.checkedPartitions.includes(partition)||part.tablePresent!==Boolean(expected)
      ||part.instance!==(expected?.target??null)||preSample!==postSample||part.readerPinned!==true||part.sourceInstanceHeld!==true)return fail();
    return {partition,tablePresent:Boolean(expected),instance:expected?.target??null,preSample,postSample,readerPinned:true as const,sourceInstanceHeld:true as const};
  },1);
  unique(partitions.map(part=>part.partition));
  const expectedPartitionCount=integer(row.expectedPartitionCount,128),completedPartitionCount=integer(row.completedPartitionCount,128);
  if(expectedPartitionCount!==schema.checkedPartitions.length||completedPartitionCount!==expectedPartitionCount||partitions.length!==expectedPartitionCount)return fail();
  return {format:'wechat-history-fixed-snapshot-proof-v1',status:'verified',scopeDigest:schema.scopeDigest,sourceGeneration:scope.sourceGeneration,
    schemaFingerprint:schema.schemaFingerprint,expectedPartitionCount,completedPartitionCount,namespaceContinuity:true,instanceContinuity:true,snapshotBarrier:true,
    scope:'single-fixed-snapshot',authorizesSubsequentRead:false,partitions};
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
function receivedTestMetadataObservation(value: unknown, scope: ResolvedWechatScope, schema: WechatSchemaInspection, action: WechatTestMetadataAction): WechatReceivedTestMetadataObservation {
  const row = object(value, ['format', 'status', 'scopeDigest', 'sourceGeneration', 'schemaFingerprint', 'action', 'checkedPartitions', 'lockedCount', 'records']);
  if (row.format !== 'wechat-received-test-metadata-observation-v1' || row.status !== 'unverified' || row.action !== action) return fail();
  if (hash(row.scopeDigest) !== digest(`${scope.accountKey}\0${scope.conversationKey}`) || hash(row.sourceGeneration) !== scope.sourceGeneration) return fail();
  if (hash(row.schemaFingerprint) !== schema.schemaFingerprint) return fail();
  const checkedPartitions = list(row.checkedPartitions, 128, hash, 1); unique(checkedPartitions);
  if (JSON.stringify([...checkedPartitions].sort()) !== JSON.stringify([...schema.checkedPartitions].sort())) return fail();
  const lockedCount = integer(row.lockedCount, 2), records = list(row.records, 2, value => value === null ? null : metadataRecord(value, schema));
  if (records.length !== lockedCount) return fail();
  return { format: 'wechat-received-test-metadata-observation-v1', status: 'unverified', scopeDigest: schema.scopeDigest,
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
interface ActiveImage { token: string; sourceGeneration: string; expectedBytes: number; expectedSha256: string; nextOffset: number }
/** 只提供已选目标的固定协议；正文分页另需当前支持认证，不提供通用命令、SQL或路径RPC。 */
export class NarrowWechatClient {
  readonly #stoppedSignal=Promise.withResolvers<void>();
  readonly #options: NarrowWechatClientOptions;
  #queue: Promise<void> = Promise.resolve();
  #native?: NativeProcess;
  #selected?: ResolvedWechatScope;
  #account?: WechatAccountMetadata;
  #schema?: WechatSchemaInspection;
  #support?: HistorySupportReport;
  #growthFromSchema?: string;
  #target?: HistoryTarget;
  #activeImage?: ActiveImage;
  #tailCursor?: string;
  #lastTail?: { input: string; page: HistoryTailPage };
  #quarantineTarget?: HistoryTarget;
  #testMetadata?: TestMetadataState;
  #receivedTestMetadata?: TestMetadataState;
  #pending?: PendingResponse;
  #stopped = false;
  #failureCode = 'history_native_closed';
  #stopping?: Promise<void>;
  constructor(options: NarrowWechatClientOptions) { this.#options = validatedOptions(options); }
  get stopped():Promise<void>{return this.#stoppedSignal.promise;}
  get stoppedReason():string|null{return this.#stopped?this.#failureCode:null;}
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
      this.#selected = { ...scope }; this.#schema = undefined; this.#support = undefined; this.#growthFromSchema=undefined; this.#target = undefined; this.#tailCursor = undefined; this.#lastTail = undefined; this.#quarantineTarget = undefined; return scope;
    }, signal);
  }
  inspectSelected(signal?: AbortSignal): Promise<WechatSchemaInspection> {
    try { signalValid(signal); } catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(async () => {
      const scope = this.#selected;
      if (!scope) return fail('history_scope_unverified');
      return this.#request({ op: 'inspect', account: scope.accountKey, conversation: scope.conversationKey, consent: 'selected-schema-v1' }, value => {
        const parsed = inspection(value, scope);
        if(this.#schema&&this.#schema.schemaFingerprint!==parsed.schemaFingerprint){
          if(this.#growthFromSchema||this.#support?.capabilities?.partitionGrowth!=='supported'||!isSafePartitionGrowth(this.#schema,parsed))fail('history_support_changed');
          this.#growthFromSchema=this.#schema.schemaFingerprint;
        }
        if(this.#support&&this.#support.schemaFingerprint!==parsed.schemaFingerprint&&this.#growthFromSchema!==this.#support.schemaFingerprint)fail('history_support_changed');
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
  verifySnapshotMetadataSelected(signal?:AbortSignal):Promise<WechatFixedSnapshotProof>{
    try{signalValid(signal);}catch{return Promise.reject(new StorageFailure('history_request_invalid'));}
    return this.#enqueue(async()=>{
      const scope=this.#selected,schema=this.#schema;
      if(!scope||!schema)return fail('history_scope_unverified');
      return this.#request({op:'verify-snapshot-metadata',account:scope.accountKey,conversation:scope.conversationKey,consent:'selected-snapshot-metadata-v1'},
        value=>fixedSnapshotProof(value,scope,schema));
    },signal);
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
  observeReceivedTestMetadataSelected(action: WechatTestMetadataAction, signal?: AbortSignal): Promise<WechatReceivedTestMetadataObservation> {
    try { signalValid(signal); if (!['arm', 'next', 'current'].includes(action)) fail('history_request_invalid'); }
    catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(async () => {
      const scope = this.#selected, schema = this.#schema, previous = this.#receivedTestMetadata;
      if (!scope || !schema) return fail('history_scope_unverified');
      if (action === 'arm' && previous) return fail('history_request_invalid');
      if (action !== 'arm' && !previous) return fail('history_snapshot_closed');
      if (previous && (previous.scopeDigest !== schema.scopeDigest || previous.sourceGeneration !== scope.sourceGeneration)) {
        await this.#stop('history_source_changed'); return fail('history_source_changed');
      }
      if (previous && previous.schemaFingerprint !== schema.schemaFingerprint) {
        await this.#stop('history_schema_changed'); return fail('history_schema_changed');
      }
      return this.#request({ op: 'observe-received-test-metadata', account: scope.accountKey, conversation: scope.conversationKey,
        consent: 'selected-received-test-lifecycle-metadata-v1', kind: action }, value => {
        const parsed = receivedTestMetadataObservation(value, scope, schema, action), identities = [...(previous?.identities ?? [])];
        if (action === 'arm' ? parsed.lockedCount !== 0 : parsed.lockedCount < identities.length
          || parsed.lockedCount > identities.length + (action === 'next' ? 1 : 0)
          || action === 'current' && parsed.lockedCount !== identities.length) return fail('history_identity_ambiguous');
        parsed.records.forEach((record, index) => {
          if (index < identities.length) {
            if (record !== null && metadataIdentity(record) !== identities[index]) fail('history_identity_ambiguous');
          } else {
            if (record === null || record.localId === null || record.sender !== 'contact' || metadataKind(record.originalType) !== 'text') return fail('history_identity_ambiguous');
            const identity = metadataIdentity(record);
            if (identities.includes(identity)) fail('history_identity_ambiguous');
            identities.push(identity);
          }
        });
        this.#receivedTestMetadata = { scopeDigest: parsed.scopeDigest, sourceGeneration: parsed.sourceGeneration, schemaFingerprint: parsed.schemaFingerprint, identities };
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
        if (parsed.status === 'supported' && (parsed.profileId === absentPrivateTargetProfile
          ? !this.#schema || this.#schema.tables.length > 0
          : this.#schema?.tables.length === 0)) fail();
        if (parsed.status === 'supported' && this.#schema && this.#schema.tables.some(table => JSON.stringify(table.declaredPrimaryKey) !== JSON.stringify(parsed.declaredPrimaryKey))) fail();
        const growth=this.#support&&this.#growthFromSchema===this.#support.schemaFingerprint&&isPartitionGrowthTargetChange(this.#support,parsed);
        if (this.#schema && parsed.schemaFingerprint !== this.#schema.schemaFingerprint
          || this.#support && parsed.schemaFingerprint !== this.#support.schemaFingerprint&&!growth
          || this.#support?.status === 'supported' && parsed.status === 'supported' && JSON.stringify(parsed) !== JSON.stringify(this.#support)&&!growth) fail('history_support_changed');
        if (parsed.status !== 'supported') { this.#target = undefined; this.#tailCursor = undefined; this.#lastTail = undefined; }
        this.#support = structuredClone(parsed);this.#growthFromSchema=undefined; return parsed;
      });
    }, signal);
  }
  targetSelected(signal?: AbortSignal): Promise<HistoryTarget> {
    try { signalValid(signal); } catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(async () => {
      const scope = this.#readableScope();
      return this.#request({ op: 'target', account: scope.accountKey, conversation: scope.conversationKey, consent: 'selected-history-v1' }, value => {
        const parsed = historyTarget(value, scope, this.#schema); this.#target = structuredClone(parsed); this.#tailCursor = undefined; this.#lastTail = undefined; this.#quarantineTarget=undefined; return parsed;
      });
    }, signal);
  }
  openImageSelected(target: HistoryTarget, identity: WechatImageSourceIdentity, signal?: AbortSignal): Promise<WechatImageOpenResult> {
    let source:WechatImageSourceIdentity;
    try { signalValid(signal); source=imageIdentity(identity); }
    catch { return Promise.reject(new StorageFailure('history_image_request_invalid')); }
    return this.#enqueue(async()=>{
      const scope=this.#readableScope(),accepted=this.#target;
      const parsed=historyTarget(target,scope,this.#schema);
      if(!accepted||JSON.stringify(parsed)!==JSON.stringify(accepted))return fail('history_target_unverified');
      if(this.#activeImage)return fail('history_image_request_invalid');
      if(!accepted.tables.some(item=>item.partition===source.partition&&item.instance===source.table))return fail('history_image_association_unverified');
      const opened=await this.#request({op:'image-open',account:scope.accountKey,conversation:scope.conversationKey,consent:'selected-image-v1',
        target:accepted.descriptor,partition:source.partition,table:source.table,localId:source.localId,serverId:source.serverId,sentAt:source.sentAt},
        value=>imageOpen(value,scope,accepted,source,32*1024*1024));
      this.#activeImage={token:opened.resourceToken,sourceGeneration:opened.sourceGeneration,expectedBytes:opened.expectedBytes,expectedSha256:opened.expectedSha256,nextOffset:0};
      return opened;
    },signal);
  }
  readImageSelected(resourceToken:string, offset:number, signal?:AbortSignal):Promise<WechatImageReadResult> {
    let token:string;
    try {signalValid(signal);token=imageToken(resourceToken);integer(offset,32*1024*1024);}
    catch {return Promise.reject(new StorageFailure('history_image_request_invalid'));}
    return this.#enqueue(async()=>{
      const active=this.#activeImage;
      if(!active||active.token!==token)return fail('history_image_token_invalid');
      if(offset!==active.nextOffset||offset>=active.expectedBytes)return fail('history_image_offset_invalid');
      return this.#request({op:'image-read',resourceToken:active.token,offset},
        value=>imageRead(value,active,offset));
    },signal);
  }
  closeImageSelected(resourceToken:string, signal?:AbortSignal):Promise<void> {
    let token:string;
    try {signalValid(signal);token=imageToken(resourceToken);}
    catch {return Promise.reject(new StorageFailure('history_image_request_invalid'));}
    return this.#enqueue(async()=>{
      const active=this.#activeImage;
      if(!active||active.token!==token)return fail('history_image_token_invalid');
      await this.#request({op:'image-close',resourceToken:active.token},value=>{
        const row=object(value,['closed']);if(row.closed!==true)return fail('history_image_token_invalid');return true;
      });
      this.#activeImage=undefined;
    },signal);
  }
  resumeTargetSelected(previous: HistoryTarget, cursor: string, signal?: AbortSignal): Promise<HistoryTarget | null> {
    try { signalValid(signal); opaque(cursor); } catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(async () => {
      const scope=this.#readableScope();
      if(this.#support?.capabilities?.durableIncremental!=='supported')return fail('history_tail_unsupported');
      const old=historyTarget(previous,scope);
      const current=this.#schema&&{protocol:'private-history-v1' as const,descriptor:'current-schema',sourceGeneration:scope.sourceGeneration,
        partitions:this.#schema.tables.length?[...new Set(this.#schema.tables.map(table=>table.partition))]:this.#schema.checkedPartitions,
        tables:this.#schema.tables.map(table=>({partition:table.partition,instance:table.target})),checkedPartitions:this.#schema.checkedPartitions};
      if(!current||!historyTargetTransition(old,current,this.#support.capabilities?.partitionGrowth==='supported'))return fail('history_target_unverified');
      return this.#request({op:'resume-target',account:scope.accountKey,conversation:scope.conversationKey,consent:'selected-history-v1',target:old.descriptor,cursor},value=>{
        if(value===null)return null;
        const parsed=historyTarget(value,scope,this.#schema);this.#target=structuredClone(parsed);this.#tailCursor=undefined;this.#lastTail=undefined;return parsed;
      });
    },signal);
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
      return this.#request({ op: 'page', account: scope.accountKey, conversation: scope.conversationKey, consent: 'selected-history-v1', target: accepted.descriptor, cursor: cursor ?? '' }, value => {
        const page = historyPage(value, accepted, cursor);
        if (page.resumeCursor && this.#support?.capabilities?.incrementalTail !== 'supported') return fail();
        if (page.resumeCursor) this.#tailCursor = page.resumeCursor;
        return page;
      }, pageResponseLimit);
    }, signal);
  }
  /** 同一活守卫的固定切面检查点；不接受由调用方拼接或跨进程恢复的游标。 */
  tailSelected(target: HistoryTarget, cursor: string, signal?: AbortSignal): Promise<HistoryTailPage> {
    try { signalValid(signal); opaque(cursor); }
    catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(() => {
      const scope = this.#readableScope();
      if (this.#support?.capabilities?.incrementalTail !== 'supported') return fail('history_tail_unsupported');
      const parsed = historyTarget(target, scope, this.#schema);
      if (!this.#target || JSON.stringify(parsed) !== JSON.stringify(this.#target)) return fail('history_target_unverified');
      const replay = this.#lastTail?.input === cursor;
      if (cursor !== this.#tailCursor && !replay) return fail('history_cursor_invalid');
      return this.#request({ op: 'tail', account: scope.accountKey, conversation: scope.conversationKey, consent: 'selected-history-v1', target: parsed.descriptor, cursor }, value => {
        const page = historyTailPage(value, parsed, cursor);
        // 重放仍交给原生守卫复验，只接受上一页的相同响应，不能改变已交付检查点。
        if (replay) { if (JSON.stringify(page) !== JSON.stringify(this.#lastTail!.page)) return fail('history_protocol_invalid'); }
        else { this.#tailCursor = page.cursorOut; this.#lastTail = { input: cursor, page: structuredClone(page) }; }
        return page;
      }, pageResponseLimit);
    }, signal);
  }
  /** 返回元数据边界，正文/媒体不属于此协议；能力未经认证时零RPC拒绝。 */
  boundarySnapshotSelected(signal?: AbortSignal): Promise<HistoryBoundaryCandidate> {
    try { signalValid(signal); } catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(() => {
      const scope = this.#readableScope(), schema = this.#schema, support = this.#support!;
      if (!schema) return fail('history_scope_unverified');
      if (support.capabilities?.[boundaryProtocol] !== 'supported') return fail('history_boundary_unsupported');
      return this.#request({ op: 'boundary-snapshot', account: scope.accountKey, conversation: scope.conversationKey, consent: 'selected-history-boundary-v1' }, value => historyBoundary(value, scope, schema, structuredClone(support)), boundaryResponseLimit);
    }, signal);
  }
  /** 明确同意的单次隔离快照；不提升普通历史支持档，不提供自动重试或续读。 */
  quarantineTargetSelected(signal?: AbortSignal): Promise<HistoryTarget> {
    try { signalValid(signal); } catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(() => {
      const scope = this.#selected;
      if (!scope || !this.#schema || this.#support?.capabilities?.programVersion !== 'supported' || this.#support.capabilities.exactSchema !== 'supported'
        || this.#support.capabilities.declaredLocalKey !== 'supported') return fail('history_support_unverified');
      return this.#request({op:'quarantine-target',account:scope.accountKey,conversation:scope.conversationKey,consent:'selected-quarantine-history-v1'},value=>{
        const parsed=historyTarget(value,scope,this.#schema);this.#quarantineTarget=structuredClone(parsed);this.#target=undefined;this.#tailCursor=undefined;this.#lastTail=undefined;return parsed;
      });
    },signal);
  }
  quarantinePageSelected(target: HistoryTarget, cursor: string | null, signal?: AbortSignal): Promise<{kind:'quarantine';page:HistoryPage}> {
    try { signalValid(signal); if(cursor!==null)opaque(cursor); } catch { return Promise.reject(new StorageFailure('history_request_invalid')); }
    return this.#enqueue(() => {
      const scope=this.#selected,accepted=this.#quarantineTarget;
      if(!scope||!accepted||JSON.stringify(target)!==JSON.stringify(accepted))return fail('history_target_unverified');
      if(cursor!==null)opaque(cursor);
      return this.#request({op:'quarantine-page',account:scope.accountKey,conversation:scope.conversationKey,consent:'selected-quarantine-history-v1',target:accepted.descriptor,cursor:cursor??''},value=>({kind:'quarantine' as const,page:historyPage(value,accepted,cursor,'quarantine')}),pageResponseLimit);
    },signal);
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
    // 微信沿用主进程明确选定的账号配置；DSH 的 HOME 仍保持隔离，不继承其余宿主环境。
    if (!this.#options.environment && process.env.NOTALONE_WECHAT_CONFIG !== undefined) {
      const configPath = process.env.NOTALONE_WECHAT_CONFIG;
      if (!path.isAbsolute(configPath) || configPath.length > 1024 || /[\0\r\n]/.test(configPath)) fail('history_account_unavailable');
      environment.WECHAT_CLI_CONFIG = configPath;
    }
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
  async #request<T>(request: Record<string, string | number>, parse: (value: unknown) => T, limit = responseLimit): Promise<T> {
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
    this.#stopped = true; this.#failureCode = allowedErrors.has(code) ? code : 'history_native_unavailable'; this.#selected = undefined; this.#account = undefined; this.#schema = undefined; this.#support = undefined; this.#target = undefined; this.#activeImage=undefined; this.#tailCursor = undefined; this.#lastTail = undefined; this.#quarantineTarget=undefined; this.#testMetadata = undefined; this.#receivedTestMetadata = undefined;
    this.#stoppedSignal.resolve();
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
