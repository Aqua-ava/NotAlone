import type { ReplyCandidate, ReplyUsedSkill } from './reply-bridge';

export interface SavedAssistantTurn {
  turnId: string;
  inputVersionId: string;
  requestKey: string;
  state: 'running' | 'completed' | 'failed' | 'redacted' | 'unavailable';
  input: { content: Record<string, unknown> } | null;
  reply: { replyRequestId: string; candidates: ReplyCandidate[]; contextEvidenceIds: string[]; usedSkill?: ReplyUsedSkill | null } | null;
  placeholder: string | null;
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
} & ({ type: 'purpose_exploration'; purposeHint: string }
  | { type: 'response_exploration'; targetMessageId: string });
export interface SavedAssistantInput {
  inputVersionId: string;
  type: 'generation' | 'purpose_exploration' | 'response_exploration';
  conversationBindingId: string;
  turnId: string | null;
  state: 'active' | 'redacted' | 'unavailable';
  content: SavedAssistantDiscussion | null;
  placeholder: string | null;
}
export interface AssistantSessionCatalog {
  phase: 'idle' | 'loading' | 'ready' | 'failed';
  items: { sessionId: string; isCurrent: boolean }[];
  currentSessionId: string | null;
  selectionPending?: boolean;
}
