import type { ContactSelection } from './contact-session-bridge';
import type { AssistantSessionCatalog, SavedAssistantSession } from './assistant-session';
import type { ConfirmedAssistantSessionDeletion } from './assistant-session-deletion-events';

export interface AssistantSessionDeletion extends ContactSelection { sessionId: string; confirmed: true; }
export interface AssistantSessionSelection extends ContactSelection { sessionId: string; }
export type ReplyGenerationBlock = 'foreground-confirmation-required' | null;

/** 当前助手只展示SQLite讨论；候选及实际输入由各自的具名接口读取。 */
export interface ReplySessionState {
  revision: number;
  scopeRevision: number;
  contactId: string | null;
  generationBlock: ReplyGenerationBlock;
  inputClearRevision?: number;
  sourceAvailability?: 'checking' | 'failed';
  savedSession?: SavedAssistantSession;
  sessionCatalog?: AssistantSessionCatalog;
  contextRefresh?: { sessionId: string };
  sessionDeletion?: 'deleting' | 'failed' | 'deleted' | 'missing';
  confirmedSessionDeletion?: ConfirmedAssistantSessionDeletion;
}

// 增量只在同一联系人范围和连续修订内合并；跨范围发布完整投影。
export type ReplyStateUpdate = { kind: 'snapshot'; state: ReplySessionState }
  | { kind: 'patch'; baseRevision: number; revision: number; contactId: string | null; scopeRevision: number;
      changes: Partial<ReplySessionState> };
export interface ReplyBridge {
  getState(): Promise<ReplySessionState>;
  retrySourceValidation(selection: ContactSelection): Promise<void>;
  readSavedSession(selection: ContactSelection): Promise<void>;
  listSavedSessions(selection: ContactSelection): Promise<void>;
  newSavedSession(selection: ContactSelection): Promise<void>;
  viewSavedSession(selection: AssistantSessionSelection): Promise<void>;
  resumeSavedSession(selection: AssistantSessionSelection): Promise<void>;
  deleteSavedSession(selection: AssistantSessionDeletion): Promise<void>;
  onStateChanged(listener: (state: ReplySessionState) => void): () => void;
}
