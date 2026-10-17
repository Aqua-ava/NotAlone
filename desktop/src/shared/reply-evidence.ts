import type { ReplyCandidateSelection } from './reply-bridge';
import type { MemoryTiming } from './memory-bridge';
import type { ReplyBasisChange } from './reply-basis-change';

export interface ReplyEvidenceNavigation {
  scopeKind: 'contact' | 'owner';
  projectionRevision: string;
  memoryId: string;
  memoryRevision: number;
  provenanceKind: 'manual_entry' | 'source_supported';
}
export interface ReplyOverviewRevision { projectionRevision: string; memoryRevision: number; }
export interface ReplyMemoryRetrievalBudget {
  limit: number; charLimit: number; usedCount: number; usedChars: number; exhausted: boolean;
}
export interface ReplyRetrievalQuery {
  kind: 'confirmed_memory' | 'owner_memory' | 'pending_candidate' | 'message';
  purpose: 'recall' | 'source_window';
  status: 'succeeded' | 'empty' | 'budget_exceeded' | 'failed';
  evidenceIds: string[];
  limit: number;
}
export interface ReplyRetrievalReceipt {
  version: 1;
  retrieverVersion: 'lexical-v1';
  status: 'succeeded' | 'empty' | 'budget_exhausted' | 'unavailable';
  overviewRevisions: { contact: ReplyOverviewRevision | null; owner: ReplyOverviewRevision | null; };
  queries: ReplyRetrievalQuery[];
  budgets: { contactMemory: ReplyMemoryRetrievalBudget; ownerMemory: ReplyMemoryRetrievalBudget;
    pendingCandidate: ReplyMemoryRetrievalBudget;
    sourceMessages: { callLimit: number; itemLimit: number; tokenLimit: number;
      usedCalls: number; usedCount: number; usedTokens: number; exhausted: boolean; }; };
}
export interface ReplyEvidenceItem {
  evidenceId: string;
  kind: 'message' | 'confirmed_memory' | 'owner_memory' | 'user_draft' | 'user_purpose' | 'continued_candidate' | 'pending_candidate';
  text: string;
  selectionReason: string;
  snapshotStatus: string;
  cited: boolean;
  timing: MemoryTiming;
  validAt: string | null;
  invalidAt: string | null;
  navigation?: ReplyEvidenceNavigation;
}
export interface ReplyEvidenceState {
  revision: number;
  scopeRevision: number;
  contactId: string | null;
  replyRequestId: string | null;
  candidateId: string | null;
  phase: 'idle' | 'loading' | 'ready' | 'failed' | 'missing';
  items: ReplyEvidenceItem[];
  basisChanges?: ReplyBasisChange[];
  retrieval?: ReplyRetrievalReceipt | null;
}
export interface ReplyEvidenceCommands {
  getEvidenceState(): Promise<ReplyEvidenceState>;
  loadEvidence(selection: ReplyCandidateSelection): Promise<void>;
  closeEvidence(selection: ReplyCandidateSelection): Promise<void>;
  onEvidenceChanged(listener: (state: ReplyEvidenceState) => void): () => void;
}
