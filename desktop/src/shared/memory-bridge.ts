import type { ContactSelection } from './contact-session-bridge';

export type MemoryCategory = 'common_fact' | 'preference' | 'taboo' | 'recent_state' | 'relationship_note';
export type MemoryTopic = 'health' | 'work' | 'family' | 'travel' | 'finance' | 'study' | 'emotion' | 'other';
export interface MemoryTiming {
  recordedAt: string | null;
  sourceStartedAt: string | null;
  sourceEndedAt: string | null;
  sourceTimeComplete: boolean;
}
export interface MemoryContent {
  text: string;
  category: MemoryCategory;
  topic: MemoryTopic;
  sourceIds: string[];
  confidence: number;
  riskFlags: string[];
  timing: MemoryTiming;
  validAt: string | null;
  invalidAt: string | null;
}
export interface ActiveMemory extends MemoryContent {
  memoryId: string;
  level: 'contact' | 'owner';
  adoptionMethod: 'auto' | 'manual';
  status: 'active';
  revision: number;
  supersedesMemoryId: string | null;
  sourceCandidateId: string | null;
}
export interface PendingMemoryCandidate extends MemoryContent {
  candidateId: string;
  subject: 'self' | 'contact' | 'shared';
  status: 'pending';
}
export interface MemorySource {
  sourceId: string;
  fileName: string | null;
  recordCount: number;
  status: 'active' | 'delete_requested' | 'deleting' | 'delete_failed' | 'deleted';
}
export interface MemorySection<T> {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  items: T[];
}
export type MemorySectionName = 'contact' | 'owner' | 'pending' | 'sources';
export interface MemoryReadingState {
  revision: number;
  contactId: string | null;
  scopeRevision: number;
  mutation: { phase: 'idle' | 'working' | 'success' | 'error'; message: string };
  contact: MemorySection<ActiveMemory>;
  owner: MemorySection<ActiveMemory>;
  pending: MemorySection<PendingMemoryCandidate>;
  sources: MemorySection<MemorySource>;
}
export interface MemoryReadRequest extends ContactSelection { section?: MemorySectionName; }
export interface MemoryAdditionRequest extends ContactSelection {
  level: 'owner' | 'contact'; text: string; category: MemoryCategory;
}
export interface MemoryRemovalRequest extends ContactSelection {
  level: 'owner' | 'contact'; memoryId: string; revision: number;
}
export interface MemoryCorrectionRequest extends ContactSelection {
  level: 'owner' | 'contact'; memoryId: string; revision: number; text: string; category: MemoryCategory;
}
export interface MemoryBridge {
  getState(): Promise<MemoryReadingState>;
  refresh(request: MemoryReadRequest): Promise<void>;
  add(request: MemoryAdditionRequest): Promise<void>;
  remove(request: MemoryRemovalRequest): Promise<void>;
  correct(request: MemoryCorrectionRequest): Promise<void>;
  onStateChanged(listener: (state: MemoryReadingState) => void): () => void;
}
