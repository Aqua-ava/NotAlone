export type BackgroundTaskSelection =
  | { scope: 'contact'; contactId: string; scopeRevision: number }
  | { scope: 'owner'; scopeRevision: number };

export type BackgroundTaskType = 'import' | 'observation' | 'delete' | 'skill_learning'
  | 'layered_memory' | 'memory_upgrade';
export type BackgroundTaskStatus = 'queued' | 'running' | 'verifying' | 'succeeded'
  | 'failed' | 'cancelled' | 'paused' | 'interrupted';
export type BackgroundTaskAction =
  | { kind: 'stop' }
  | { kind: 'recover'; target: 'tasks' | 'skill_learning' }
  | { kind: 'recover'; target: 'layered_memory'; workRevision: number; settingsGeneration: number };

export interface BackgroundTaskStep {
  name: string;
  status: string;
  attemptCount: number;
  processedCount: number;
  totalCount: number | null;
  errorCode: string | null;
  leaseExpiresAt: string | null;
}

export interface BackgroundTask {
  taskId: string;
  taskType: BackgroundTaskType;
  status: BackgroundTaskStatus;
  phase: string;
  messageCount: number;
  retryCount: number;
  errorCode: string | null;
  processedCount: number;
  totalCount: number | null;
  updatedAt: string;
  steps: BackgroundTaskStep[];
  actions: BackgroundTaskAction[];
}

export interface BackgroundTaskState {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  scope: 'contact' | 'owner' | null;
  contactId: string | null;
  scopeRevision: number;
  tasks: BackgroundTask[];
  hasMore: boolean;
  error: string | null;
  busyTaskId: string | null;
  message: string | null;
}

export interface BackgroundTaskBridge {
  read(request: BackgroundTaskSelection): Promise<void>;
  stop(request: BackgroundTaskSelection & { taskId: string }): Promise<void>;
  recover(request: BackgroundTaskSelection & { taskId: string }): Promise<void>;
  cancelRead(request: BackgroundTaskSelection): Promise<void>;
  getState(): Promise<BackgroundTaskState>;
  onStateChanged(listener: (state: BackgroundTaskState) => void): () => void;
}
