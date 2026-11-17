import type { SqliteDiscussionEntry, SqliteRuntimeRecovery } from './sqlite-discussion';

export interface SavedAssistantSession {
  phase: 'idle' | 'loading' | 'ready' | 'failed';
  sessionId: string | null;
  discussionEntries: SqliteDiscussionEntry[];
  runtimeRecovery: SqliteRuntimeRecovery;
}

export interface AssistantSessionCatalog {
  phase: 'idle' | 'loading' | 'ready' | 'failed';
  items: { sessionId: string; isCurrent: boolean; lastUserActivityAt?: string | null }[];
  currentSessionId: string | null;
  selectionPending?: boolean;
}
