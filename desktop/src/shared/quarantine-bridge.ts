/** 隔离目录没有联系人归属，也不向业务页面提供正文或本机路径。 */
export interface QuarantineSnapshot {
  id: string;
  displayName: string;
  recordCount: number;
  createdAt: number;
  snapshotComplete: boolean;
  snapshotState: 'ready' | 'running' | 'complete' | 'incomplete';
}
export interface QuarantineBridge {
  list(): Promise<QuarantineSnapshot[]>;
  open(id: string): Promise<void>;
}
