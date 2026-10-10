import type { ReplyCandidateSelection } from './reply-bridge';

export interface ReplyEvidenceItem {
  evidenceId: string;
  kind: 'message' | 'confirmed_memory' | 'owner_memory' | 'user_draft' | 'user_purpose' | 'continued_candidate' | 'pending_candidate';
  text: string;
  selectionReason: string;
  snapshotStatus: string;
  cited: boolean;
  timing: { recordedAt: string | null; sourceStartedAt: string | null; sourceEndedAt: string | null; sourceTimeComplete: boolean };
  validAt: string | null;
  invalidAt: string | null;
}
export interface ReplyEvidenceState {
  revision: number;
  scopeRevision: number;
  contactId: string | null;
  replyRequestId: string | null;
  candidateId: string | null;
  phase: 'idle' | 'loading' | 'ready' | 'failed' | 'missing';
  items: ReplyEvidenceItem[];
}
export interface ReplyEvidenceCommands {
  getEvidenceState(): Promise<ReplyEvidenceState>;
  loadEvidence(selection: ReplyCandidateSelection): Promise<void>;
  closeEvidence(selection: ReplyCandidateSelection): Promise<void>;
  onEvidenceChanged(listener: (state: ReplyEvidenceState) => void): () => void;
}
