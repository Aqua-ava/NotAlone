/** SQLite 固定轮次；提取核验成功不表示主题与概览已完成。 */
export type FixedProcessingRunState = 'pending' | 'running' | 'paused' | 'failed' | 'incomplete' | 'revoked' | 'completed';
/** 统一轮次状态：待处理、处理中、暂停、受阻、完成；历史失败不得冒充当前状态。 */
export type FixedProcessingStatus = 'waiting' | 'processing' | 'paused' | 'blocked' | 'completed';
export type FixedProcessingControlAction = 'pause' | 'continue';
export interface FixedProcessingCallSummary {
  prepared: number; sending: number; succeeded: number; failed: number; unknown: number;
}
export type FixedProcessingTaskState = FixedProcessingRunState | 'unknown' | 'succeeded' | 'awaiting_decision';
export interface FixedProcessingTask {
  taskId: string; scopeKind: 'contact' | 'self'; contactId: string | null; state: FixedProcessingTaskState;
  total: number; succeeded: number; errorCode: string | null;
}
export interface FixedProcessingInput {
  inputNo: number; role: 'target' | 'context'; contactId: string; messageId: string; recordId: string; itemId: string | null;
}
export interface FixedProcessingCandidate {
  id: string; scopeKind: 'contact' | 'self'; contactId: string | null; body: string;
  state: 'verified_pending_decision'; origin: 'auto';
}
export interface FixedProcessingRun {
  runId: string; state: FixedProcessingRunState; total: number; succeeded: number; failed: number; unknown: number;
  stage: 'extraction_verification' | 'document_scene' | 'document_profile' | 'completed'; laterStages: 'pending' | 'completed'; tasks: FixedProcessingTask[];
  /** 控制投影：固定轮次的统一状态、可执行动作、固定原因与计数；不含百分比。 */
  status: FixedProcessingStatus; statusReason: string | null; sharedFaultCode: string | null; actions: FixedProcessingControlAction[];
  /** 后续阶段合并等待的最早执行时间；到期仍须重新核验资格。 */
  nextDueAt?: number | null;
  controlVersion: number; pending: number; revoked: number; calls: FixedProcessingCallSummary;
  inputs: FixedProcessingInput[]; candidates: FixedProcessingCandidate[];
}
export interface FixedProcessingEvent {
  eventId: string; attemptId: string; kind: string; payload: unknown; callId: string | null;
  inputNos: number[]; sources: {contactId: string; recordId: string}[];
}
export interface FixedProcessingCall {
  callId: string; operationId: string; purpose: string; state: 'prepared' | 'sending' | 'succeeded' | 'failed' | 'unknown';
  provider: string; requestKey: string; reservedBudgetUnits: string; actualBudgetUnits: string | null;
}
export interface FixedProcessingTrace { events: FixedProcessingEvent[]; calls: FixedProcessingCall[] }
export interface FixedProcessingQueue {
  pending: number; nextDueAt: number | null; blockedContacts: number;
  later?: { pending: number; nextDueAt: number | null; stage: 'document_scene' | 'document_profile' | null };
}
export interface FixedProcessingView { connectionGeneration: number; contactId?: string; run: FixedProcessingRun | null; queue?: FixedProcessingQueue }
export interface FixedProcessingRead { contactId: string }
export interface FixedProcessingMode { connectionGeneration: number; mode: 'sqlite' | 'legacy' }
export interface FixedProcessingStart { requestKey: string; connectionGeneration: number }
export interface FixedProcessingHistoryStart extends FixedProcessingStart { contactId: string; scopeRevision: number }
export type FixedHistoryFailureReason = 'no_pending_history' | 'busy' | 'blocked' | 'scope_changed' | 'source_stale';
export type FixedProcessingHistoryResult = {status:'started';view:FixedProcessingView} | {status:'unavailable';reason:FixedHistoryFailureReason};
export interface FixedProcessingControl { runId: string; controlVersion: number; operationId: string; connectionGeneration: number }
export interface FixedProcessingTraceRequest { taskId: string; connectionGeneration: number }
export interface FixedMemoryProcessingBridge {
  readMode(): Promise<FixedProcessingMode>;
  readCurrent(request?: FixedProcessingRead): Promise<FixedProcessingView>;
  start(request: FixedProcessingStart): Promise<FixedProcessingView>;
  startHistory(request: FixedProcessingHistoryStart): Promise<FixedProcessingHistoryResult>;
  pause(request: FixedProcessingControl): Promise<FixedProcessingView>;
  continue(request: FixedProcessingControl): Promise<FixedProcessingView>;
  trace(request: FixedProcessingTraceRequest): Promise<FixedProcessingTrace>;
  release(): Promise<void>;
  onInvalidated(listener: () => void): () => void;
}
