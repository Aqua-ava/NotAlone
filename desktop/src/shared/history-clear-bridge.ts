/** 清空聊天与明确重读历史的页面合同：只含状态、进度和原因码，不含正文、渠道键或边界证明原文。 */
export type HistoryClearPhase = 'none' | 'boundary_pending' | 'cleaning' | 'cleanup_blocked' | 'completed';
export interface HistoryBoundaryView {
  state: 'pending' | 'verified' | 'blocked';
  barrierGeneration: string;
  manifestSha256: string | null;
  memberCount: number | null;
  reason: string | null;
  establishedAt: string | null;
}
export interface HistoryClearView {
  contactId: string;
  phase: HistoryClearPhase;
  completed: boolean;
  boundary: HistoryBoundaryView | null;
  boundaryPending: boolean;
  failureCode: string | null;
  boundaryReason: string | null;
  storedMessages: number;
  storedSources: number;
  openGoals: number;
}
export type HistoryResyncPhase = 'none' | 'authorized' | 'active' | 'completed';
export interface HistoryResyncView {
  contactId: string;
  requestKey: string | null;
  state: HistoryResyncPhase;
  completed: boolean;
  goalPhase: 'not_started' | 'syncing' | 'complete' | 'incomplete' | null;
  messageCount: number;
  nonTextCount: number;
  failureCode: string | null;
}
export interface HistoryClearState {
  revision: number;
  contactId: string | null;
  scopeRevision: number;
  phase: 'idle' | 'loading' | 'ready' | 'failed';
  clear: HistoryClearView | null;
  resync: HistoryResyncView | null;
  busy: 'clear' | 'resync' | null;
  error: string | null;
}
export interface HistoryClearRequest { contactId: string; scopeRevision: number }
export interface HistoryResyncRequest extends HistoryClearRequest { requestKey: string; confirmed: true }
export interface HistoryClearBridge {
  getState(): Promise<HistoryClearState>;
  refresh(request: HistoryClearRequest): Promise<void>;
  clear(request: HistoryClearRequest): Promise<void>;
  resync(request: HistoryResyncRequest): Promise<void>;
  onStateChanged(listener: (state: HistoryClearState) => void): () => void;
}
