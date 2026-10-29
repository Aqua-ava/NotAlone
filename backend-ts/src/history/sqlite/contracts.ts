import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';

/** 只由受信任渠道适配器提供；HTTP/renderer 不得注入支持档或原始消息。 */
export interface HistorySupportReport {
  protocol: 'private-history-v1'; profileId: string; adapterVersion: string;
  status: 'supported' | 'unsupported' | 'unverified'; reason: string | null;
  accountKey: string; conversationKey: string; sourceGeneration: string;
  programVersion: string; build: string; artifactSha256: string;
  schemaFingerprint: string; declaredPrimaryKey: readonly string[];
  serverAliasSemantics?: 'verified_within_scope' | 'unverified' | 'unsupported';
  capabilities?: Readonly<Record<string, 'supported' | 'unsupported' | 'unverified'>>;
  identity: 'source-table-local-v1'; statusSemantics: string; continuity: string;
}
export interface HistoryScope {
  token: ReadEligibility; accountKey: string; conversationKey: string;
}
export interface HistoryTarget {
  protocol: 'private-history-v1'; descriptor: string;
  partitions: readonly string[]; tables: readonly {partition:string;instance:string}[]; sourceGeneration: string;
}
export interface HistoryRecord {
  partition: string; table: string; localId: string | null; serverId: string | null;
  sender: 'owner' | 'contact' | 'unknown'; kind: 'text' | 'image' | 'voice' | 'video' | 'file' | 'sticker' | 'other';
  text: string | null; originalType: string;
  sentAt: string | null; timePrecision: 'millisecond' | 'second' | null;
  orderScheme: string | null; orderKey: string | null;
  status?: string | null;
}
export interface HistoryPage {
  target: string; cursorIn: string | null; cursorOut: string | null;
  records: readonly HistoryRecord[];
  // 只有核验过的固定目标、完整分片及可靠续读协议才能报告终页。
  completedPartitions: readonly string[]; exhausted: boolean;
}
export interface HistoryChannel {
  inspect(scope: HistoryScope, signal?: AbortSignal): Promise<HistorySupportReport>;
  target(scope: HistoryScope, signal?: AbortSignal): Promise<HistoryTarget>;
  page(scope: HistoryScope, target: HistoryTarget, cursor: string | null, signal?: AbortSignal): Promise<HistoryPage>;
  close?(): Promise<void>;
}
export type HistoryPhase = 'not_started' | 'running' | 'complete' | 'incomplete';
export interface HistoryCoverage {
  goalId: string | null; contactId: string; bindingId: string | null;
  phase: HistoryPhase; failureCode: string | null; cursor: string | null;
  messageCount: number; nonTextCount: number; pageCount: number; quarantinedCount: number;
}
export interface StoredMessage {
  id: string; contactId: string; bindingId: string; sender: 'owner' | 'contact';
  kind: HistoryRecord['kind']; text: string | null; originalType: string;
  sentAt: string | null; timePrecision: HistoryRecord['timePrecision'];
  orderScheme: string | null; orderKey: string | null;
  status?: string | null;
  // 当前按保存位置分页；ordering描述展示次序，不能从原消息orderScheme推定。
  displayPosition: string; ordering: 'verified' | 'unknown'; sourceRecordIds: string[];
}
export interface HistoryRead {
  messages: StoredMessage[]; coverage: HistoryCoverage;
  replyEligibility: 'ready' | 'history_syncing' | 'history_incomplete';
}
/** 仅供受信任派生服务固定实际来源；隔离记录不从此入口流出。 */
export interface HistorySource {
  recordId: string; contactId: string; messageId: string; captureId: string; goalId: string;
  itemNo: number; capturedAt: string; adapterVersion: string; normalizerVersion: string;
  cursorIn: string | null; cursorOut: string | null;
  raw: HistoryRecord; support: HistorySupportReport;
}
export interface MessageSourceReference {
  owner_id: string; contact_id: string; record_id: string; message_id: string;
}
