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
}
