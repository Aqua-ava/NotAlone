export interface DiagnosticLogState { enabled: boolean; bytes: number; available: boolean }
export interface DiagnosticLogBridge {
  getState(): Promise<DiagnosticLogState>;
  setEnabled(enabled: boolean): Promise<DiagnosticLogState>;
  clear(): Promise<DiagnosticLogState>;
  exportBundle(): Promise<{ status: 'saved' | 'cancelled' }>;
}
