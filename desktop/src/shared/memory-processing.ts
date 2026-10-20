import type { ContactSelection } from './contact-session-bridge';

export type MemoryProcessingRequest = { scope: 'owner' } | ({ scope: 'contact' } & ContactSelection);
export type MemoryProcessingAction = 'resume' | 'restart';
export type MemoryProcessingResumeRequest = MemoryProcessingRequest & { taskId: string; action: MemoryProcessingAction };
export type MemoryProcessingStatus = 'queued' | 'extracting' | 'organizing' | 'completed' | 'interrupted' | 'failed' | 'stopped';
export interface MemoryProcessingTask {
  taskId: string;
  contactId: string;
  taskType: 'import' | 'observation';
  status: MemoryProcessingStatus;
  phase: string;
  processedCount: number | null;
  totalCount: number | null;
  createdCount: number | null;
  updatedCount: number | null;
  updatedAt: string;
  reasonCode: string | null;
  action: MemoryProcessingAction | null;
}
export interface MemoryProcessing {
  scope: 'owner' | 'contact';
  hasMore: boolean;
  contactId: string | null;
  tasks: MemoryProcessingTask[];
}
