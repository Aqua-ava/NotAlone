import type { ContactSelection } from './contact-session-bridge';
import type { ExpressionPreferenceReceipt } from './expression-preference-bridge';
import type { ReplyEvidenceCommands } from './reply-evidence';
import type { AssistantSessionCatalog, SavedAssistantSession } from './assistant-session';
import type { AssistantInputBudget, AssistantInputBudgetNotice } from './assistant-input-budget';
import type { ConfirmedAssistantSessionDeletion } from './assistant-session-deletion-events';
import type { AssistantCandidateDraft, ReplyCandidateDraftUpdate, AssistantCandidateVersionsState, ExplicitAssistantCandidateSelection, ReplyCandidateVersionDisplay, ReplyCandidateVersionEdit, ReplyCandidateVersionRead, ReplyCandidateVersionSelection } from './assistant-candidate-versions';
import type { AssistantContinuationClarification, RequirementChange } from './assistant-continuation-clarification';
import type { ReplyBasisChange } from './reply-basis-change';
import type { SkillPublicationScope } from './skill-learning-bridge';

export type RewriteTone = 'original' | 'warm' | 'concise' | 'polite';
export interface RewriteOptions {
  tone: RewriteTone;
  instruction: string;
  includeRelationshipContext: boolean;
  inputKind?: 'draft' | 'current_chat';
  pastedDirection?: string;
}
export interface RewriteOptionsUpdate extends ContactSelection { options: RewriteOptions; }
export interface GenerateReply extends ContactSelection { newRequest: boolean; }
export interface AssistantInterruptedRetry extends ContactSelection { sessionId: string; turnId: string; inputVersionId: string; }
export interface AssistantSessionDeletion extends ContactSelection { sessionId: string; confirmed: true; }
export interface AssistantSessionSelection extends ContactSelection { sessionId: string; }
export interface AssistantCandidateCarry extends AssistantSessionSelection {
  expectedSelectionId: string; candidateId: string; versionId: string;
}
export interface ReplyContinuation extends AssistantSessionSelection {
  instruction: string;
  intentionUpdate?: string;
  requirementChanges?: readonly RequirementChange[];
}
export interface ReplyContinuationConfirmation extends AssistantSessionSelection {
  expectedInputVersionId: string;
  requirementChanges: readonly RequirementChange[];
}
export interface ReplyContinuationState {
  phase: 'waiting' | 'clarification' | 'completed' | 'failed';
  sessionId: string;
  expectedInputVersionId: string;
  canRetry: boolean;
  clarification?: AssistantContinuationClarification;
  effectiveRequirements?: readonly string[];
  message?: string;
}
export type ReplyMode = 'rewrite_draft' | 'reply_to_message' | 'initiate_conversation';
export interface ReplyModeUpdate extends ContactSelection { mode: ReplyMode; }
export interface ReplyMessagePageRequest extends ContactSelection { older: boolean; }
export interface ReplyMessageSelection extends ContactSelection { messageId: string; }
export interface ReplyDirectionUpdate extends ContactSelection { direction: string; }
export interface ReplyCorrectionUpdate extends ContactSelection { correction: string; }
export interface ReplySupplementUpdate extends ContactSelection { supplement: string; }
export interface ReplyDirectionChoice extends ContactSelection { suggestionId: string; inputVersion: string; }
export interface ReplySkillVersion { name: string; versionId: string; versionNumber: number; }
export interface ReplyUsedSkill {
  name: string; versionId: string; loadState: 'loaded' | 'resource_failed';
  versionNumber?: number | null; scope?: SkillPublicationScope;
  executionView?: { policyRevision: number; methodIds: string[]; sha256: string };
}
export type ReplySkillChoice = { mode: 'auto' | 'disabled'; versionId: null } | { mode: 'user'; versionId: string };
export interface ReplySkillUpdate extends ContactSelection { skill: ReplySkillChoice; }
export interface ReplySceneUpdate extends ContactSelection { scene: string; }
export interface ReplyRequirementsUpdate extends ContactSelection { requirements: string; }
export interface ReplyClarificationEdit extends ContactSelection { questionId: string; inputVersion: string; }
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
  scene?: string | null;
  inputKind?: 'draft' | 'current_chat';
  pastedDirection?: string;
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
  scene?: string | null;
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
  scene?: string | null;
}
export type ReplyInputSnapshot = RewriteSnapshot | DirectedReplySnapshot | ProactiveReplySnapshot;
export interface ReplyResult {
  replyRequestId: string;
  assistantSessionId?: string;
  inputVersionId?: string;
  input: ReplyInputSnapshot;
  candidates: EditableReplyCandidate[];
  contextEvidenceIds: string[];
  basisChanges?: ReplyBasisChange[];
  styleSampleIds?: string[];
  expressionPreferenceIds?: string[];
  expressionPreferences?: ExpressionPreferenceReceipt[];
  usedSkill?: ReplyUsedSkill | null;
  inputBudget?: AssistantInputBudget;
  continuation?: { candidateId: string | null; versionId: string | null; candidateGroupId: string };
}
export type ReplyFailureCode = 'generation_failed' | 'save_failed' | 'timeout' | 'unavailable' | 'rejected' | 'candidates_rejected' | 'target_unavailable' | 'source_unavailable' | 'connection' | 'input_budget_exceeded' | 'input_budget_unavailable' | 'provider_context_limit' | 'prepared_context_reprepare_required' | 'prepared_context_running' | 'prepared_context_unconfirmed';
export type ReplyGenerationBlock = 'foreground-confirmation-required' | null;
export interface ReplyMessageNotice { phase: 'idle' | 'connecting' | 'connected' | 'interrupted'; changed: boolean; needsRefresh: boolean; }
export interface ReplyGenerationJobState {
  contactId: string; sessionId: string; requestKey: string; turnId: string; inputVersionId: string;
  phase: 'queued' | 'generating' | 'completed' | 'failed' | 'unconfirmed';
  canRetry?: boolean;
}
export interface ReplySessionState {
  generationJobs?: ReplyGenerationJobState[];
  generationRecoveryPending?: number;

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
  supplementInput?: boolean;
  clarificationAnswer: string;
  skillChoice: ReplySkillChoice;
  scene?: string;
  skillChoices: ReplySkillVersion[];
  exploration: { phase: 'idle' | 'waiting' | 'ready' | 'failed' | 'paused'; result: DirectionExploration | null; canRetry?: boolean; automaticUpdatesPaused?: boolean };
  purpose: string;
  phase: 'idle' | 'waiting' | 'ready' | 'failed';
  errorCode?: ReplyFailureCode;
  sourceAvailability?: 'checking' | 'failed';
  result: ReplyResult | null;
  selectedCandidateId: string | null;
  candidateVersions?: AssistantCandidateVersionsState;
  candidateDrafts?: AssistantCandidateDraft[];
  contentRestoreNotice?: string;
  explicitCandidateSelection?: ExplicitAssistantCandidateSelection;
  canRetry: boolean;
  savedSession?: SavedAssistantSession;
  sessionCatalog?: AssistantSessionCatalog;
  sessionDeletion?: 'deleting' | 'failed' | 'deleted' | 'missing';
  inputBudgetNotice?: AssistantInputBudgetNotice;
  continuation?: ReplyContinuationState;
}
export interface ReplyCandidateSelection extends ContactSelection { replyRequestId: string; candidateId: string; }
export interface ReplyCandidateEdit extends ReplyCandidateSelection { text: string; }
export interface ReplyBridge extends ReplyEvidenceCommands {
  getState(): Promise<ReplySessionState>;
  updateOptions(update: RewriteOptionsUpdate): Promise<ReplySessionState>;
  setMode(update: ReplyModeUpdate): Promise<void>;
  loadMessages(request: ReplyMessagePageRequest): Promise<void>;
  reconnectMessages(selection: ContactSelection): Promise<void>;
  combineNewMessages(selection: ContactSelection): Promise<void>;
  retrySourceValidation(selection: ContactSelection): Promise<void>;
  readSavedSession(selection: ContactSelection): Promise<void>;
  listSavedSessions(selection: ContactSelection): Promise<void>;
  newSavedSession(selection: ContactSelection): Promise<void>;
  newSavedSessionWithCandidate(selection: AssistantCandidateCarry): Promise<void>;
  selectSavedSession(selection: AssistantSessionSelection): Promise<void>;
  deleteSavedSession(selection: AssistantSessionDeletion): Promise<void>;
  selectMessage(selection: ReplyMessageSelection): Promise<ReplySessionState>;
  updateDirection(update: ReplyDirectionUpdate): Promise<ReplySessionState>;
  updateCorrection(update: ReplyCorrectionUpdate): Promise<ReplySessionState>;
  updateSupplement(update: ReplySupplementUpdate): Promise<ReplySessionState>;
  explore(selection: ContactSelection): Promise<void>;
  changeDirections(selection: ContactSelection): Promise<void>;
  beginClarificationEdit(selection: ReplyClarificationEdit): Promise<ReplySessionState>;
  answerClarification(selection: ReplyClarificationAnswer): Promise<void>;
  stopExploration(selection: ContactSelection): Promise<void>;
  retryExploration(selection: ContactSelection): Promise<void>;
  updateRequirements(update: ReplyRequirementsUpdate): Promise<ReplySessionState>;
  updateSkill(update: ReplySkillUpdate): Promise<ReplySessionState>;
  updateScene(update: ReplySceneUpdate): Promise<ReplySessionState>;
  selectDirection(selection: ReplyDirectionChoice): Promise<ReplySessionState>;
  updatePurpose(update: ReplyPurposeUpdate): Promise<ReplySessionState>;
  generate(selection: GenerateReply): Promise<void>;
  continueSession(command: ReplyContinuation): Promise<void>;
  confirmContinuation(command: ReplyContinuationConfirmation): Promise<void>;
  retryContinuation(selection: AssistantSessionSelection): Promise<void>;
  retryInterruptedGeneration(request: AssistantInterruptedRetry): Promise<void>;
  selectCandidate(selection: ReplyCandidateSelection): Promise<ReplySessionState>;
  editCandidate(edit: ReplyCandidateEdit): Promise<ReplySessionState>;
  updateCandidateVersionDraft(update: ReplyCandidateDraftUpdate): Promise<ReplySessionState>;
  readCandidateVersions(request: ReplyCandidateVersionRead): Promise<ReplySessionState>;
  saveCandidateVersion(edit: ReplyCandidateVersionEdit): Promise<ReplySessionState>;
  selectCandidateVersion(selection: ReplyCandidateVersionSelection): Promise<ReplySessionState>;
  showCandidateVersion(selection: ReplyCandidateVersionDisplay): Promise<ReplySessionState>;
  onStateChanged(listener: (state: ReplySessionState) => void): () => void;
}
