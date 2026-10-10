import type { ContactSelection } from './contact-session-bridge';

export type TraceResource = 'memory-traces' | 'source-processing-traces';
export type TraceRecordKind = 'message' | 'candidate' | 'contact_memory' | 'owner_memory' | 'source_document' | 'local_wechat_observation' | 'source_ref';
export type TraceDocument = Record<string, unknown>;
export interface TraceBatch {
  batchId: string;
  status: string;
  recordedAt: string;
  retryOf: string | null;
}
export interface TraceState {
  revision: number;
  contactId: string | null;
  scopeRevision: number;
  resource: TraceResource;
  phase: 'idle' | 'loading' | 'ready' | 'error';
  message: string;
  batches: TraceBatch[];
  nextBefore: string | null;
  availability: 'recorded' | 'deleted' | 'not_recorded' | 'not_applicable' | null;
  detail: TraceDocument | null;
}
export interface TraceListRequest extends ContactSelection { resource: TraceResource; older?: boolean; }
export interface TraceBatchRequest extends ContactSelection { resource: TraceResource; batchId: string; }
export interface TraceFindRequest extends ContactSelection { resource: TraceResource; kind: TraceRecordKind; recordId: string; }
export interface TraceBridge {
  getState(): Promise<TraceState>;
  list(request: TraceListRequest): Promise<void>;
  find(request: TraceFindRequest): Promise<void>;
  show(request: TraceBatchRequest): Promise<void>;
  remove(request: TraceBatchRequest): Promise<void>;
  onStateChanged(listener: (state: TraceState) => void): () => void;
}
