import type { ContactSelection } from './contact-session-bridge';
import type { ReplyEvidenceCommands } from './reply-evidence';
import type { AssistantSessionCatalog, SavedAssistantSession } from './assistant-session';
import type { ConfirmedAssistantSessionDeletion } from './assistant-session-deletion-events';

export type RewriteTone = 'original' | 'warm' | 'concise' | 'polite';
export interface RewriteOptions {
  tone: RewriteTone;
  instruction: string;
  includeRelationshipContext: boolean;
}
export interface RewriteOptionsUpdate extends ContactSelection { options: RewriteOptions; }
export interface GenerateReply extends ContactSelection { newRequest: boolean; }
export interface AssistantSessionDeletion extends ContactSelection { sessionId: string; confirmed: true; }
export interface AssistantSessionSelection extends ContactSelection { sessionId: string; }
export type ReplyMode = 'rewrite_draft' | 'reply_to_message' | 'initiate_conversation';
export interface ReplyModeUpdate extends ContactSelection { mode: ReplyMode; }
export interface ReplyMessagePageRequest extends ContactSelection { older: boolean; }
export interface ReplyMessageSelection extends ContactSelection { messageId: string; }
export interface ReplyDirectionUpdate extends ContactSelection { direction: string; }
export interface ReplyCorrectionUpdate extends ContactSelection { correction: string; }
export interface ReplyDirectionChoice extends ContactSelection { suggestionId: string; inputVersion: string; }
export interface ReplySkillVersion { name: string; versionId: string; versionNumber: number; }
export interface ReplyUsedSkill { name: string; versionId: string; loadState: 'loaded' | 'resource_failed'; }
export type ReplySkillChoice = { mode: 'auto' | 'disabled'; versionId: null } | { mode: 'user'; versionId: string };
export interface ReplySkillUpdate extends ContactSelection { skill: ReplySkillChoice; }
export interface ReplyRequirementsUpdate extends ContactSelection { requirements: string; }
export interface ReplyClarificationAnswer extends ContactSelection { answer: string; questionId: string; inputVersion: string; }
export interface DirectionExploration {
  taskId: string; sessionId: string; inputVersion: string; understanding: string; ambiguities: string[];
  evidence: { evidenceId: string; text: string; sourceIds: string[] }[];
  directions: { suggestionId: string; title: string; direction: string; reason: string; citationIds: string[]; recommended: boolean; pause: boolean }[];
  citationIds: string[]; question: { questionId: string; text: string } | null; confirmedIntent: string | null;
  currentStep: string; tradeoffs: string[]; usedSkill: ReplySkillVersion | null; skillChoices: ReplySkillVersion[];
}
export interface ReplyPurposeUpdate extends ContactSelection { purpose: string; }
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
  correction?: string;
  userInstruction?: string;
  clarificationAnswer?: string;
  skillChoice?: ReplySkillChoice;
}
export interface ProactiveReplySnapshot {
  mode: 'initiate_conversation';
  contactId: string;
  contactDisplayName: string;
  purpose: string;
  correction?: string;
  userInstruction?: string;
  clarificationAnswer?: string;
  skillChoice?: ReplySkillChoice;
}
export type ReplyInputSnapshot = RewriteSnapshot | DirectedReplySnapshot | ProactiveReplySnapshot;
export interface ReplyResult {
  replyRequestId: string;
  assistantSessionId?: string;
  inputVersionId?: string;
  input: ReplyInputSnapshot;
  candidates: EditableReplyCandidate[];
  contextEvidenceIds: string[];
  styleSampleIds?: string[];
  usedSkill?: ReplyUsedSkill | null;
}
export type ReplyFailureCode = 'generation_failed' | 'save_failed' | 'timeout' | 'unavailable' | 'rejected' | 'target_unavailable' | 'source_unavailable' | 'connection';
export type ReplyGenerationBlock = 'foreground-confirmation-required' | null;
export interface ReplyMessageNotice { phase: 'idle' | 'connecting' | 'connected' | 'interrupted'; changed: boolean; needsRefresh: boolean; }
export interface ReplySessionState {
  revision: number;
  confirmedSessionDeletion?: ConfirmedAssistantSessionDeletion;
  scopeRevision: number;
  contactId: string | null;
  generationBlock: ReplyGenerationBlock;
  options: RewriteOptions;
  // 与删除后的默认输入一起发布；普通状态回显不覆盖组件内的新编辑。
  inputClearRevision?: number;
  mode: ReplyMode;
  messages: ReplyMessagesState;
  messageNotice: ReplyMessageNotice;
  targetMessageId: string | null;
  direction: string;
  correction: string;
  requirements: string;
  clarificationAnswer: string;
  skillChoice: ReplySkillChoice;
  skillChoices: ReplySkillVersion[];
  exploration: { phase: 'idle' | 'waiting' | 'ready' | 'failed' | 'paused'; result: DirectionExploration | null; canRetry?: boolean };
  purpose: string;
  phase: 'idle' | 'waiting' | 'ready' | 'failed';
  errorCode?: ReplyFailureCode;
  sourceAvailability?: 'checking' | 'failed';
  result: ReplyResult | null;
  selectedCandidateId: string | null;
  canRetry: boolean;
  savedSession?: SavedAssistantSession;
  sessionCatalog?: AssistantSessionCatalog;
  sessionDeletion?: 'deleting' | 'failed' | 'deleted' | 'missing';
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
  readSavedSession(selection: ContactSelection): Promise<void>;
  listSavedSessions(selection: ContactSelection): Promise<void>;
  newSavedSession(selection: ContactSelection): Promise<void>;
  selectSavedSession(selection: AssistantSessionSelection): Promise<void>;
  deleteSavedSession(selection: AssistantSessionDeletion): Promise<void>;
  selectMessage(selection: ReplyMessageSelection): Promise<ReplySessionState>;
  updateDirection(update: ReplyDirectionUpdate): Promise<ReplySessionState>;
  updateCorrection(update: ReplyCorrectionUpdate): Promise<ReplySessionState>;
  explore(selection: ContactSelection): Promise<void>;
  changeDirections(selection: ContactSelection): Promise<void>;
  answerClarification(selection: ReplyClarificationAnswer): Promise<void>;
  stopExploration(selection: ContactSelection): Promise<void>;
  retryExploration(selection: ContactSelection): Promise<void>;
  updateRequirements(update: ReplyRequirementsUpdate): Promise<ReplySessionState>;
  updateSkill(update: ReplySkillUpdate): Promise<ReplySessionState>;
  selectDirection(selection: ReplyDirectionChoice): Promise<ReplySessionState>;
  updatePurpose(update: ReplyPurposeUpdate): Promise<ReplySessionState>;
  generate(selection: GenerateReply): Promise<void>;
  selectCandidate(selection: ReplyCandidateSelection): Promise<ReplySessionState>;
  editCandidate(edit: ReplyCandidateEdit): Promise<ReplySessionState>;
  onStateChanged(listener: (state: ReplySessionState) => void): () => void;
}
