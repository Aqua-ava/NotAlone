export type DiagnosticModule = 'contacts' | 'memory.management' | 'memory.processing' | 'history.sync' | 'media' | 'reply' | 'deletion' | 'startup' | 'foreground' | 'diagnostics';
export interface DiagnosticEvent {
  event: string; module?: DiagnosticModule; traceId?: string; interruptedTraceId?: string;
  reasonCode?: string; caller?: string; contactPrefix?: string; runId?: string; taskId?: string; batchId?: string;
  durationMs?: number; count?: number; action?: string; fromRevision?: number; toRevision?: number;
  fromState?: string; toState?: string; sqlFingerprint?: string;
  callId?: string; imageId?: string; originalBytes?: number; sentBytes?: number; imageCount?: number; requestBytes?: number;
  width?: number; height?: number; mimeType?: string; stage?: string; failureCategory?: string;
}
export interface DiagnosticRecord extends DiagnosticEvent { time: string; level: 'debug' | 'info' | 'warn' | 'error'; proc: 'main' | 'backend' | 'renderer'; module: DiagnosticModule }
export const diagnosticEvents: Readonly<Record<string, { readonly module: DiagnosticModule | null; readonly level: DiagnosticRecord['level']; readonly fields: readonly string[] }>>;
export const diagnosticModules: readonly DiagnosticModule[];
export const diagnosticReasons: readonly string[];
export const diagnosticCallers: readonly string[];
export const diagnosticStates: readonly string[];
export function checkedDiagnosticEvent(value: unknown): DiagnosticEvent | undefined;
export function checkedDiagnosticRecord(value: unknown): DiagnosticRecord | undefined;
