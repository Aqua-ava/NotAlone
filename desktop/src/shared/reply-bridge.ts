import type { ContactSelection } from './contact-session-bridge';

export type RewriteTone = 'original' | 'warm' | 'concise' | 'polite';
export interface RewriteOptions {
  tone: RewriteTone;
  instruction: string;
  includeRelationshipContext: boolean;
}
export interface RewriteOptionsUpdate extends ContactSelection { options: RewriteOptions; }
export interface GenerateRewrite extends ContactSelection { newRequest: boolean; }
export interface ReplyCandidate {
  candidateId: string;
  text: string;
  basis: string;
  citationIds: string[];
  riskNotes: string[];
}
export interface EditableReplyCandidate { original: ReplyCandidate; editedText: string; }
export interface RewriteSnapshot {
  contactId: string;
  contactDisplayName: string;
  draftText: string;
  userInstruction: string | null;
  includeRelationshipContext: boolean;
}
export interface ReplyResult {
  replyRequestId: string;
  input: RewriteSnapshot;
  candidates: EditableReplyCandidate[];
  contextEvidenceIds: string[];
}
export type ReplyFailureCode = 'generation_failed' | 'timeout' | 'unavailable' | 'rejected' | 'connection';
export interface ReplySessionState {
  revision: number;
  scopeRevision: number;
  contactId: string | null;
  options: RewriteOptions;
  phase: 'idle' | 'waiting' | 'ready' | 'failed';
  errorCode?: ReplyFailureCode;
  result: ReplyResult | null;
  selectedCandidateId: string | null;
  canRetry: boolean;
}
export interface ReplyCandidateSelection extends ContactSelection { replyRequestId: string; candidateId: string; }
export interface ReplyCandidateEdit extends ReplyCandidateSelection { text: string; }
export interface ReplyBridge {
  getState(): Promise<ReplySessionState>;
  updateOptions(update: RewriteOptionsUpdate): Promise<ReplySessionState>;
  generate(selection: GenerateRewrite): Promise<void>;
  selectCandidate(selection: ReplyCandidateSelection): Promise<ReplySessionState>;
  editCandidate(edit: ReplyCandidateEdit): Promise<ReplySessionState>;
  onStateChanged(listener: (state: ReplySessionState) => void): () => void;
}
