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

// 路径与文件摘要只在主进程中保存，选择版本只标记本次用户确认。
export interface ImportState {
  revision: number;
  selectionRevision: number;
  phase: 'unavailable' | 'idle' | 'choosing' | 'previewing' | 'previewed' | 'confirming' | 'confirmed' | 'error';
  fileName: string | null;
  target: ImportTarget | null;
  preview: ImportPreviewSummary | null;
  error: string | null;
}

export interface ImportSelectionVersion { selectionRevision: number; }
export interface ImportBridge {
  getState(): Promise<ImportState>;
  chooseFile(): Promise<void>;
  setTarget(target: ImportTarget): Promise<void>;
  preview(selection: ImportSelectionVersion): Promise<void>;
  confirmPreview(selection: ImportSelectionVersion): Promise<void>;
  cancelConfirmation(selection: ImportSelectionVersion): Promise<void>;
  onStateChanged(listener: (state: ImportState) => void): () => void;
}
