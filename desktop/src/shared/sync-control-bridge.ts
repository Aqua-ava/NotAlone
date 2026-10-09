export type BackgroundSyncPhase = 'disabled' | 'waiting_bindings' | 'active' | 'degraded';
export type ForegroundReportPhase = 'sync_disabled' | 'waiting_foreground' | 'unavailable' | 'active' | 'failed';

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
}
export interface SyncControlState {
  revision: number;
  scopeRevision: number;
  phase: 'offline' | 'loading' | 'ready' | 'unavailable' | 'failed';
  report: SyncStatusReport | null;
  busy: 'enable' | 'disable' | null;
  errorCode: 'status-unconfirmed' | 'operation-unconfirmed' | null;
}
export interface SyncSwitchRequest { scopeRevision: number; }
export interface SyncControlBridge {
  getState(): Promise<SyncControlState>;
  refresh(): Promise<void>;
  enable(request: SyncSwitchRequest): Promise<void>;
  disable(request: SyncSwitchRequest): Promise<void>;
  onStateChanged(listener: (state: SyncControlState) => void): () => void;
}
