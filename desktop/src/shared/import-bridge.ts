export type ImportTarget = { kind: 'existing'; contactId: string } | { kind: 'new'; displayName: string };

export interface ImportIdentity { externalId: string; observedName: string; }
export interface ImportPreviewSummary {
  fileName: string;
  recordCount: number;
  kindCounts: Record<string, number>;
  ownerIdentity: ImportIdentity;
  contactIdentity: ImportIdentity;
  targetName: string;
}

export type ImportTaskStatus = 'queued' | 'running' | 'verifying' | 'succeeded' | 'failed' | 'cancelled';
export type ImportStepName = 'parse' | 'normalize' | 'extract_memory' | 'index' | 'verify';
export interface ImportTaskStep {
  name: ImportStepName;
  status: 'pending' | 'running' | 'succeeded' | 'retryable' | 'failed' | 'cancelled';
  attemptCount: number;
  processedCount: number;
  totalCount: number;
  error: string | null;
}
export interface ImportTask {
  taskId: string;
  status: ImportTaskStatus;
  step: ImportStepName;
  messageCount: number;
  retryCount: number;
  error: string | null;
  steps: ImportTaskStep[];
}
export interface ImportReceipt { contactId: string; taskId: string; importedCount: number; skippedDuplicates: number; }
export interface ImportSource { sourceId: string; fileName: string; recordCount: number; status: 'active' | 'delete_requested' | 'deleted'; }
export interface ImportSubmission {
  fileName: string;
  targetName: string;
  receipt: ImportReceipt | null;
  task: ImportTask | null;
  taskBusy: 'refresh' | 'retry' | 'run' | null;
  taskError: string | null;
  sources: ImportSource[] | null;
  sourcesError: boolean;
  syncReloadNeeded: boolean;
}

// 路径与文件摘要只在主进程中保存，选择版本只标记本次用户确认。
export interface ImportState {
  revision: number;
  selectionRevision: number;
  phase: 'unavailable' | 'idle' | 'choosing' | 'previewing' | 'previewed' | 'confirming' | 'confirmed' | 'submitting' | 'submitted' | 'error';
  fileName: string | null;
  target: ImportTarget | null;
  preview: ImportPreviewSummary | null;
  error: string | null;
  submission: ImportSubmission | null;
  syncReloadPhase: 'idle' | 'restarting' | 'ready' | 'failed';
}

export interface ImportSelectionVersion { selectionRevision: number; }
export interface ImportBridge {
  getState(): Promise<ImportState>;
  chooseFile(): Promise<void>;
  setTarget(target: ImportTarget): Promise<void>;
  preview(selection: ImportSelectionVersion): Promise<void>;
  confirmPreview(selection: ImportSelectionVersion): Promise<void>;
  cancelConfirmation(selection: ImportSelectionVersion): Promise<void>;
  submit(selection: ImportSelectionVersion): Promise<void>;
  refreshTask(selection: ImportSelectionVersion): Promise<void>;
  retryTask(selection: ImportSelectionVersion): Promise<void>;
  runTask(selection: ImportSelectionVersion): Promise<void>;
  reloadSyncHost(selection: ImportSelectionVersion): Promise<void>;
  onStateChanged(listener: (state: ImportState) => void): () => void;
}
