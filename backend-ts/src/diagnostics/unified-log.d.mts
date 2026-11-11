import type { DiagnosticEvent, DiagnosticRecord } from './unified-contract.mjs';
export interface DiagnosticStatus { enabled: boolean; bytes: number; available: boolean }
export interface DiagnosticLogOptions { proc?: 'main' | 'backend'; development?: boolean; maxFileBytes?: number; maxTotalBytes?: number; maxAgeMs?: number; now?: () => number }
export class UnifiedDiagnosticLog {
  constructor(root: string, options?: DiagnosticLogOptions);
  diagnose(input: DiagnosticEvent): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  clear(contactPrefix?: string): Promise<boolean>;
  eraseContact(contactPrefix: string): Promise<boolean>;
  eraseModelImage(imageId: string): Promise<boolean>;
  setEnabled(enabled: boolean): Promise<boolean>;
  setDebugFor(milliseconds?: number): void;
  status(): Promise<DiagnosticStatus>;
  stats(): { rejected: number; dropped: number; available: boolean };
}
export function readDiagnosticRecords(root: string): Promise<DiagnosticRecord[]>;
/** @internal 只接收受信任上下文保存的时间；不扩展公共事件字段。 */
export function writeObservedDiagnostic(log: UnifiedDiagnosticLog, input: DiagnosticEvent, observedAt: number): void;
