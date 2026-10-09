import type { ContactSelection } from './contact-session-bridge';
export type DeletionStepName = 'mark_deleted' | 'delete_derived' | 'delete_index' | 'clear_cache' | 'verify_not_retrievable';
export interface DeletionTask {
  taskId: string;
  status: 'queued' | 'running' | 'verifying' | 'succeeded' | 'failed' | 'cancelled';
  step: DeletionStepName;
  steps: { name: DeletionStepName; status: 'pending' | 'running' | 'succeeded' | 'retryable' | 'failed' | 'cancelled' }[];
}
export interface DeletionSource {
  sourceId: string; fileName: string | null; recordCount: number;
  status: 'active' | 'delete_requested' | 'deleting' | 'delete_failed' | 'deleted';
  task: DeletionTask | null;
}
export interface SourceDeletionState {
  revision: number; contactId: string | null; scopeRevision: number;
  phase: 'idle' | 'loading' | 'ready' | 'failed'; sources: DeletionSource[];
  busySourceId: string | null; error: string | null;
}
export interface SourceDeletionRequest extends ContactSelection { sourceId: string; }
export interface SourceDeletionBridge {
  getState(): Promise<SourceDeletionState>;
  refresh(request: ContactSelection): Promise<void>;
  delete(request: SourceDeletionRequest): Promise<void>;
  onStateChanged(listener: (state: SourceDeletionState) => void): () => void;
}
