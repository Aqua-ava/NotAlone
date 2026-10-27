import type { ContactSelection } from './contact-session-bridge';

export type MemoryProcessingRequest = { scope: 'owner' } | ({ scope: 'contact' } & ContactSelection);
export type MemoryProcessingControlAction = 'pause' | 'continue';
export type MemoryProcessingControlRequest = MemoryProcessingRequest & { actionVersion: number; operationId: string };
export interface MemoryProcessingControlReceipt {
  accepted: true;
  operationId: string;
  action: MemoryProcessingControlAction;
  actionVersion: number;
  controlGeneration: number;
  replayed: boolean;
}
export type MemoryProcessingHistoryRequest = MemoryProcessingRequest & { cursor: string | null };
export type MemoryProcessingStatus = 'waiting' | 'processing' | 'completed' | 'paused' | 'blocked';
export type MemoryProcessingUnit = 'messages' | 'memories' | 'steps';
export interface MemoryProcessingCurrent {
  status: MemoryProcessingStatus;
  roundId: string | null;
  phase: 'extraction' | 'verification' | 'topics' | 'profile' | 'retry' | null;
  processedCount: number | null;
  totalCount: number | null;
  unit: MemoryProcessingUnit | null;
  pendingCount: number | null;
  reason: string | null;
  reasonCode: string | null;
  hasUsableResults: boolean;
  actions: MemoryProcessingControlAction[];
}
export interface MemoryProcessingTask {
  taskId: string;
  roundId: string | null;
  contactId: string | null;
  taskType: 'import' | 'observation' | 'layered_memory';
  status: string;
  phase: string;
  processedCount: number | null;
  totalCount: number | null;
  unit: MemoryProcessingUnit | null;
  updatedAt: string;
  reasonCode: string | null;
  attribution: 'verified' | 'legacy';
}
export interface MemoryProcessingHistory {
  scope: 'owner' | 'contact';
  contactId: string | null;
  entries: MemoryProcessingTask[];
  nextCursor: string | null;
  error?: string;
}
export interface MemoryProcessing {
  scope: 'owner' | 'contact';
  contactId: string | null;
  controlGeneration: number;
  actionVersion: number;
  current: MemoryProcessingCurrent;
  history: Pick<MemoryProcessingHistory, 'entries' | 'nextCursor' | 'error'>;
}
