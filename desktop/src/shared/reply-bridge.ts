import type { ContactSelection } from './contact-session-bridge';
import type { ReplyEvidenceCommands } from './reply-evidence';

export type RewriteTone = 'original' | 'warm' | 'concise' | 'polite';
export interface RewriteOptions {
  tone: RewriteTone;
  instruction: string;
  includeRelationshipContext: boolean;
}
export interface RewriteOptionsUpdate extends ContactSelection { options: RewriteOptions; }
export interface GenerateReply extends ContactSelection { newRequest: boolean; }
export type ReplyMode = 'rewrite_draft' | 'reply_to_message';
export interface ReplyModeUpdate extends ContactSelection { mode: ReplyMode; }
export interface ReplyMessagePageRequest extends ContactSelection { older: boolean; }
export interface ReplyMessageSelection extends ContactSelection { messageId: string; }
export interface ReplyDirectionUpdate extends ContactSelection { direction: string; }
export interface ReplyMessage {
  messageId: string;
  speaker: 'user' | 'contact' | 'system';
  messageType: string;
  text: string | null;
  mediaPlaceholder: string | null;
  occurredAt: string | null;
  quoted: { text: string; targetMessageId: string | null } | null;
}
export interface ReplyMessagesState {
  phase: 'idle' | 'loading' | 'ready' | 'failed';
  items: ReplyMessage[];
  nextCursor: string | null;
}
export interface ReplyCandidate {
  candidateId: string;
  text: string;
  basis: string;
  citationIds: string[];
  riskNotes: string[];
}
export interface EditableReplyCandidate { original: ReplyCandidate; editedText: string; }
export interface RewriteSnapshot {
  mode: 'rewrite_draft';
  contactId: string;
  contactDisplayName: string;
  draftText: string;
  userInstruction: string | null;
  includeRelationshipContext: boolean;
}
export interface DirectedReplySnapshot {
  mode: 'reply_to_message';
  contactId: string;
  contactDisplayName: string;
  target: ReplyMessage;
  direction: string;
}
export type ReplyInputSnapshot = RewriteSnapshot | DirectedReplySnapshot;
export interface ReplyResult {
  replyRequestId: string;
  input: ReplyInputSnapshot;
  candidates: EditableReplyCandidate[];
  contextEvidenceIds: string[];
}
export type ReplyFailureCode = 'generation_failed' | 'timeout' | 'unavailable' | 'rejected' | 'connection';
export type ReplyGenerationBlock = 'foreground-confirmation-required' | null;
export interface ReplyMessageNotice { phase: 'idle' | 'connecting' | 'connected' | 'interrupted'; changed: boolean; needsRefresh: boolean; }
export interface ReplySessionState {
  revision: number;
  scopeRevision: number;
  contactId: string | null;
  generationBlock: ReplyGenerationBlock;
  options: RewriteOptions;
  mode: ReplyMode;
  messages: ReplyMessagesState;
  messageNotice: ReplyMessageNotice;
  targetMessageId: string | null;
  direction: string;
  phase: 'idle' | 'waiting' | 'ready' | 'failed';
  errorCode?: ReplyFailureCode;
  sourceAvailability?: 'checking' | 'failed';
  result: ReplyResult | null;
  selectedCandidateId: string | null;
  canRetry: boolean;
}
export interface ReplyCandidateSelection extends ContactSelection { replyRequestId: string; candidateId: string; }
export interface ReplyCandidateEdit extends ReplyCandidateSelection { text: string; }
export interface ReplyBridge extends ReplyEvidenceCommands {
  getState(): Promise<ReplySessionState>;
  updateOptions(update: RewriteOptionsUpdate): Promise<ReplySessionState>;
  setMode(update: ReplyModeUpdate): Promise<void>;
  loadMessages(request: ReplyMessagePageRequest): Promise<void>;
  reconnectMessages(selection: ContactSelection): Promise<void>;
  retrySourceValidation(selection: ContactSelection): Promise<void>;
  selectMessage(selection: ReplyMessageSelection): Promise<ReplySessionState>;
  updateDirection(update: ReplyDirectionUpdate): Promise<ReplySessionState>;
  generate(selection: GenerateReply): Promise<void>;
  selectCandidate(selection: ReplyCandidateSelection): Promise<ReplySessionState>;
  editCandidate(edit: ReplyCandidateEdit): Promise<ReplySessionState>;
  onStateChanged(listener: (state: ReplySessionState) => void): () => void;
}
