export type BackgroundSyncPhase = 'disabled' | 'waiting_bindings' | 'active' | 'degraded';
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

// 只展示最近循环的最小报告，不提供联系人定位、观察身份或正文。
export interface SyncStatusReport {
  enabled: boolean;
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
}
export interface SyncControlState {
  revision: number;
  scopeRevision: number;
  phase: 'offline' | 'loading' | 'ready' | 'unavailable' | 'failed';
  report: SyncStatusReport | null;
  busy: 'enable' | 'disable' | 'pause' | 'retry' | null;
  errorCode: 'status-unconfirmed' | 'operation-unconfirmed' | null;
}
export interface SyncControlRequest { scopeRevision: number; }
export interface SyncControlBridge {
  getState(): Promise<SyncControlState>;
  refresh(): Promise<void>;
  enable(request: SyncControlRequest): Promise<void>;
  disable(request: SyncControlRequest): Promise<void>;
  pause(request: SyncControlRequest): Promise<void>;
  retry(request: SyncControlRequest): Promise<void>;
  onStateChanged(listener: (state: SyncControlState) => void): () => void;
}
