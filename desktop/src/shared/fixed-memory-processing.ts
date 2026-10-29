/** SQLite 固定轮次；提取核验成功不表示主题与概览已完成。 */
export type FixedProcessingRunState = 'pending' | 'running' | 'paused' | 'failed' | 'incomplete' | 'revoked';
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
  stage: 'extraction_verification'; laterStages: 'pending'; tasks: FixedProcessingTask[];
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
export interface FixedProcessingView { connectionGeneration: number; run: FixedProcessingRun | null }
export interface FixedProcessingMode { connectionGeneration: number; mode: 'sqlite' | 'legacy' }
export interface FixedProcessingStart { requestKey: string; connectionGeneration: number }
export interface FixedProcessingControl { runId: string; connectionGeneration: number }
export interface FixedProcessingTraceRequest { taskId: string; connectionGeneration: number }
export interface FixedMemoryProcessingBridge {
  readMode(): Promise<FixedProcessingMode>;
  readCurrent(): Promise<FixedProcessingView>;
  start(request: FixedProcessingStart): Promise<FixedProcessingView>;
  pause(request: FixedProcessingControl): Promise<FixedProcessingView>;
  continue(request: FixedProcessingControl): Promise<FixedProcessingView>;
  trace(request: FixedProcessingTraceRequest): Promise<FixedProcessingTrace>;
  release(): Promise<void>;
  onInvalidated(listener: () => void): () => void;
}
