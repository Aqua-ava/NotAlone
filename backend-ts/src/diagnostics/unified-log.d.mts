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
  setEnabled(enabled: boolean): Promise<boolean>;
  setDebugFor(milliseconds?: number): void;
  status(): Promise<DiagnosticStatus>;
  stats(): { rejected: number; dropped: number; available: boolean };
}
export function readDiagnosticRecords(root: string): Promise<DiagnosticRecord[]>;
