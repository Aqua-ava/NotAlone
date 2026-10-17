import type { ReplyCandidate, ReplyUsedSkill } from './reply-bridge';
import type { AssistantInputBudget } from './assistant-input-budget';
import type { ReplyBasisChange } from './reply-basis-change';
import type { ExpressionPreferenceReceipt } from './expression-preference-bridge';

export interface SavedAssistantTurn {
  turnId: string;
  inputVersionId: string;
  requestKey: string;
  state: 'running' | 'completed' | 'failed' | 'redacted' | 'unavailable';
  input: { content: Record<string, unknown>; continued_from_candidate_id?: string | null;
    skill_version_id?: string | null; skill_disabled?: boolean; scene?: string | null } | null;
  reply: { replyRequestId: string; candidates: ReplyCandidate[]; contextEvidenceIds: string[];
    styleSampleIds?: string[]; expressionPreferenceIds?: string[]; expressionPreferences?: ExpressionPreferenceReceipt[]; usedSkill?: ReplyUsedSkill | null; inputBudget?: AssistantInputBudget; basisChanges?: ReplyBasisChange[] } | null;
  placeholder: string | null;
  interruptionReason: 'app_quit' | null;
  basisChanges?: ReplyBasisChange[];
  generationActive?: boolean;
  requiresReprepare?: boolean;
}
export interface SavedAssistantSession {
  phase: 'idle' | 'loading' | 'ready' | 'failed';
  sessionId: string | null;
  turns: SavedAssistantTurn[];
  currentInputVersionId: string | null;
  inputs: SavedAssistantInput[];
}

export type SavedAssistantDiscussion = {
  correction: string; requirements: string; answer: string; confirmedIntent: string;
  skillMode: 'auto' | 'disabled' | 'user'; skillVersionId: string | null;
  skillScene?: string | null;
} & ({ type: 'purpose_exploration'; purposeHint: string }
  | { type: 'response_exploration'; targetMessageId: string });
export interface SavedAssistantCarry {
  type: 'candidate_carry';
  originSessionId: string;
  originCandidateId: string;
  originVersionId: string;
  originSelectionId: string;
  messages: { messageId: string; text: string }[];
}
export interface SavedAssistantInput {
  inputVersionId: string;
  type: 'generation' | 'purpose_exploration' | 'response_exploration' | 'candidate_carry';
  conversationBindingId: string;
  turnId: string | null;
  state: 'active' | 'redacted' | 'unavailable';
  content: SavedAssistantDiscussion | SavedAssistantCarry | null;
  placeholder: string | null;
  basisChanges?: ReplyBasisChange[];
}
export interface AssistantSessionCatalog {
  phase: 'idle' | 'loading' | 'ready' | 'failed';
  items: { sessionId: string; isCurrent: boolean }[];
  currentSessionId: string | null;
  selectionPending?: boolean;
}
