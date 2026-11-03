export type HistoryCoveragePhase = 'not_started' | 'syncing' | 'complete' | 'incomplete';
/** 增量检查点/控制的可见阶段；不可用与受阻必须区别于已同步。 */
export type HistoryIncrementalPhase = 'not_started' | 'ready' | 'syncing' | 'incomplete' | 'blocked' | 'invalidated' | 'unavailable' | 'stopped';
export interface HistoryCoverage {
  bindingId: string;
  contactId: string;
  phase: HistoryCoveragePhase;
  failureCode: string | null;
  messageCount: number;
  nonTextCount: number;
  nonTextTypes?: { messageType: string; label: string; count: number }[];
  metadataOnlyCount?: number;
  pageCount: number;
  incrementalPhase?: HistoryIncrementalPhase;
  incrementalFailureCode?: string | null;
  incrementalAwaitingMessages?: boolean;
  incrementalLastAcceptedAt?: number | null;
  incrementalPages?: number;
}

export type SyncScope = 'selected' | 'all_private';
export type HistoryAuthorizationDecision = 'accepted' | 'declined';
export type HistoryAuthorizationState = HistoryAuthorizationDecision | 'required' | 'unknown';
export type BackgroundSyncPhase = 'disabled' | 'waiting_bindings' | 'active' | 'degraded';
export type BackgroundIncrementalPhase = 'idle' | 'active' | 'incomplete' | 'unavailable' | 'closed' | 'disabled';
export type ForegroundReportPhase = 'sync_disabled' | 'waiting_foreground' | 'unavailable' | 'active' | 'failed';
export type SyncBackfillPhase = 'not_required' | 'gap_detected' | 'backfilling' | 'complete' | 'failed' | 'incomplete' | 'paused';

export interface SyncBackfillReport {
  phase: SyncBackfillPhase;
  failureCode: string | null;
  totalContacts: number;
  completedContacts: number;
  succeededContacts: number;
  skippedContacts: number;
  failedContacts: number;
  incompleteContacts: number;
  pendingContacts: number;
  messageCount: number;
  nonTextCount: number;
}

export interface SyncPriorityReport {
  contactId: string | null;
  lastSuccessAt: string | null;
  lastDurationMs: number | null;
  lastCliDurationMs: number | null;
  lastStoreDurationMs: number | null;
  lastFailureCode: string | null;
  localHistoryState?: 'deleted' | 'empty' | null;
  queueWaitMs: number | null;
}

// 只展示最近循环的最小报告，不提供微信定位标识、观察身份或正文。
export interface SyncStatusReport {
  selectionOnly?: boolean; bodyAvailable?: boolean;
  enabled: boolean;
  syncScope?: SyncScope;
  syncScopeFailureCode?: string | null;
  historyCoverages?: HistoryCoverage[];
  historyAuthorizationState?: HistoryAuthorizationState;
  historyAuthorizationVersion?: number | null;
  historyAuthorizationCurrentVersion?: number;
  backgroundPhase: BackgroundSyncPhase;
  backgroundFailureCode: string | null;
  cliAvailable: boolean;
  confirmedBindingCount: number;
  foregroundPhase: ForegroundReportPhase;
  foregroundFailureCode: string | null;
  probeAvailable: boolean;
  wechatInFront: boolean;
  backfill: SyncBackfillReport;
  priority?: SyncPriorityReport;
  incrementalPhase?: BackgroundIncrementalPhase;
  incrementalFailureCode?: string | null;
  incrementalIdentityLimit?: number;
}
export interface SyncControlState {
  revision: number;
  scopeRevision: number;
  phase: 'offline' | 'loading' | 'ready' | 'unavailable' | 'failed';
  report: SyncStatusReport | null;
  busy: 'enable' | 'disable' | 'pause' | 'retry' | 'scope' | 'history' | null;
  errorCode: 'status-unconfirmed' | 'operation-unconfirmed' | null;
}
export interface SyncControlRequest { scopeRevision: number; }
export interface SyncScopeRequest extends SyncControlRequest { mode: SyncScope; confirmed: true; }
export interface HistoryAuthorizationRequest extends SyncControlRequest {
  decision: HistoryAuthorizationDecision; confirmed: true;
}
export interface SyncControlBridge {
  getState(): Promise<SyncControlState>;
  refresh(): Promise<void>;
  setScope(request: SyncScopeRequest): Promise<void>;
  setHistoryAuthorization(request: HistoryAuthorizationRequest): Promise<void>;
  enable(request: SyncControlRequest): Promise<void>;
  disable(request: SyncControlRequest): Promise<void>;
  pause(request: SyncControlRequest): Promise<void>;
  retry(request: SyncControlRequest): Promise<void>;
  onStateChanged(listener: (state: SyncControlState) => void): () => void;
}
