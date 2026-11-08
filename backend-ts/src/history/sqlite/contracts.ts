import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';
import type { NonTextTypeCount } from './message-types.ts';

/** 只由受信任渠道适配器提供；HTTP/renderer 不得注入支持档或原始消息。 */
export interface HistorySupportReport {
  protocol: 'private-history-v1'; profileId: string; adapterVersion: string;
  status: 'supported' | 'unsupported' | 'unverified'; reason: string | null;
  accountKey: string; conversationKey: string; sourceGeneration: string;
  programVersion: string; build: string; artifactSha256: string;
  schemaFingerprint: string; declaredPrimaryKey: readonly string[];
  serverAliasSemantics?: 'verified_within_scope' | 'unverified' | 'unsupported';
  capabilities?: Readonly<Record<string, 'supported' | 'unsupported' | 'unverified'>> & {
    partitionGrowth?: 'supported' | 'unsupported' | 'unverified';
  };
  identity: 'source-table-local-v1'; statusSemantics: string; continuity: string;
}
export interface HistoryScope {
  token: ReadEligibility; accountKey: string; conversationKey: string;
}
export interface HistoryTarget {
  protocol: 'private-history-v1'; descriptor: string;
  partitions: readonly string[]; tables: readonly {partition:string;instance:string}[]; sourceGeneration: string;
  // 全部已检查来源文件的稳定身份；只在明确认证分片表增长能力时用于恢复边界。
  checkedPartitions?: readonly string[];
}
export interface HistoryRecord {
  partition: string; table: string; localId: string | null; serverId: string | null;
  sender: 'owner' | 'contact' | 'unknown'; kind: 'text' | 'image' | 'voice' | 'video' | 'file' | 'sticker' | 'other';
  text: string | null; originalType: string;
  sentAt: string | null; timePrecision: 'millisecond' | 'second' | null;
  orderScheme: string | null; orderKey: string | null;
  status?: string | null;
  // 仅经过认证的渠道才可确认状态；未知状态不应带正文。
  stateAssurance: 'verified' | 'unverified';
  // 仅认证非文字的来源和类型，不推断消息送达或撤回。
  metadataOnly?: true;
  // 渠道已核验的具体状态；撤回是无正文终态，不能仅凭原始状态数字推断。
  messageState?: 'sent' | 'received' | 'recalled' | 'absent';
  // 仅受认可的新版 CLI 随同步页携带的引用投影；不会进入原始来源载荷。
  quote?: HistoryQuoteContent & {proofDigest:string};
  quoteErrorCode?: HistoryQuoteErrorCode;
}
/** 一对一引用解析的最小结构化结果；不保存原始 XML 或其他消息载荷。 */
export interface HistoryQuoteContent {
  replyText: string;
  referencedText: string | null;
  referencedSender: string | null;
  referencedSenderRole: 'owner' | 'contact' | 'unknown';
  referencedType: string | null;
  referencedServerId: string | null;
}
export interface StoredHistoryQuote extends HistoryQuoteContent {
  targetMessageId: string | null;
  state: 'resolved' | 'unresolved' | 'unavailable';
}
export type HistoryQuoteErrorCode = 'history_quote_unavailable' | 'history_quote_metadata_invalid' | 'history_quote_too_large'
  | 'history_quote_state_unverified' | 'history_quote_association_unverified' | 'history_quote_read_failed';
export interface HistoryPage {
  target: string; cursorIn: string | null; cursorOut: string | null;
  records: readonly HistoryRecord[];
  // 只有核验过的固定目标、完整分片及可靠续读协议才能报告终页。
  completedPartitions: readonly string[]; exhausted: boolean;
  // 终页可提供保守续读游标（允许重叠、不得跳项），供历史→增量无缺口交接；缺失表示该适配器不能证明交接。
  resumeCursor?: string | null;
  // 未终页的持久恢复证明；只有与该页同事务接受后才可跨选择或重启使用。
  checkpointCursor?: string;
}
export interface HistoryTailPage {
  target: string; cursorIn: string; cursorOut: string;
  records: readonly HistoryRecord[]; caughtUp: boolean;
}
/** 只由已接纳的本机来源生成；不得由 HTTP 或渲染层提供续读水位。 */
export interface HistoryRecoveryPosition {
  partition:string; table:string; maxLocalId:string; anchorLocalIds:readonly string[];
}
export interface HistoryRecoveryResult {
  target:HistoryTarget; cursor:string|null; anchors:readonly HistoryRecord[];
}
export interface HistoryChannel {
  // 仅已实现持续原生守卫的渠道可声明；loss 在守卫无法继续时结束。
  readonly guardSession?: { readonly loss: Promise<void>; failureCode?():string|null };
  inspect(scope: HistoryScope, signal?: AbortSignal): Promise<HistorySupportReport>;
  target(scope: HistoryScope, signal?: AbortSignal): Promise<HistoryTarget>;
  // 只接续业务事务已接受且作用域未变的本机检查点；缺失返回 null，不能猜测水位。
  resumeTarget?(scope: HistoryScope, previous: HistoryTarget, cursor: string, signal?: AbortSignal): Promise<HistoryTarget | null>;
  recoverTarget?(scope:HistoryScope, previous:HistoryTarget, positions:readonly HistoryRecoveryPosition[], signal?:AbortSignal):Promise<HistoryRecoveryResult>;
  page(scope: HistoryScope, target: HistoryTarget, cursor: string | null, signal?: AbortSignal, options?: {checkpoint?:boolean}): Promise<HistoryPage>;
  /** 仅受信任渠道对已验证的单条引用来源做有限解析，不返回原始 XML。 */
  readQuote?(scope: HistoryScope, target: HistoryTarget, source: HistorySource, signal?: AbortSignal): Promise<HistoryQuoteContent & {proofDigest: string}>;
  // 可选增量尾部能力：只由支持档声明 incrementalTail=supported 的已认证适配器提供。
  tail?(scope: HistoryScope, target: HistoryTarget, cursor: string, signal?: AbortSignal): Promise<HistoryTailPage>;
  // 共享读取器换联系人前释放本通道选择并保留进程；重试幂等，失败须确认原进程停止。
  park?(): Promise<void>;
  // 06 精确历史边界能力：仅已认证适配器提供，生产适配器不实现（空缺即拒绝）。
  boundarySnapshot?(scope: HistoryScope, signal?: AbortSignal): Promise<unknown>;
  close?(): Promise<void>;
}
export type HistoryPhase = 'not_started' | 'running' | 'complete' | 'incomplete';
/** 增量检查点的持久事实；运行中/受阻等实时状态由协调器单独投影。 */
export type HistoryIncrementalPhase = 'not_started' | 'ready' | 'incomplete' | 'invalidated' | 'unavailable';
export interface HistoryIncrementalCoverage {
  goalId: string | null; phase: HistoryIncrementalPhase; failureCode: string | null; cursorPresent: boolean;
  pagesAccepted: number; lastAcceptedAt: number | null; resumedFromGoalId: string | null;
  /** 已持久化认证空目标的低频元数据重探状态；不可由零消息数推断。 */
  emptyTargetAwaitingMessages?: true;
}
export interface HistoryCoverage {
  goalId: string | null; contactId: string; bindingId: string | null;
  phase: HistoryPhase; failureCode: string | null; cursor: string | null;
  messageCount: number; nonTextCount: number; pageCount: number; quarantinedCount: number;
  // 由已保存的原始类型码生成，不读取XML、展开引用或提升正文资格。
  nonTextTypes?: NonTextTypeCount[];
  // 无法归属发送方的独立系统等元数据观察，不作为聊天正文或派生依据。
  metadataOnlyCount?: number;
  // 固定目标已全部遍历；未知消息仍可使 phase=incomplete，不能据此宣称内容已全部核验。
  traversalComplete?: boolean;
  /** 仅展示：当前作用域内最新历史目标已完整保存；不代表来源连续性资格，不得用于读取、检索、记忆或回复判断。 */
  savedHistoryComplete?: boolean;
  incremental?: HistoryIncrementalCoverage;
}
export interface StoredMessage {
  id: string; contactId: string; bindingId: string; sender: 'owner' | 'contact';
  kind: HistoryRecord['kind']; text: string | null; originalType: string;
  sentAt: string | null; timePrecision: HistoryRecord['timePrecision'];
  orderScheme: string | null; orderKey: string | null;
  status?: string | null;
  // 当前按保存位置分页；ordering描述展示次序，不能从原消息orderScheme推定。
  displayPosition: string; ordering: 'verified' | 'unknown'; sourceRecordIds: string[];
  quote?: StoredHistoryQuote;
  quoteErrorCode?: HistoryQuoteErrorCode;
}
export interface HistoryRead {
  messages: StoredMessage[]; coverage: HistoryCoverage;
  replyEligibility: 'ready' | 'history_syncing' | 'history_incomplete';
}
export type HistoryImageMediaState = 'pending' | 'available' | 'thumbnail_only' | 'unavailable' | 'failed' | 'cleared';
export interface HistoryImageMedia {
  state: HistoryImageMediaState; fileId: string | null; mimeType: string | null; errorCode?: string | null;
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
