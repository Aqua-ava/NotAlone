import type { ReplyMessagesState } from './reply-bridge';

export interface ContactHistoryRequest {
  contactId: string;
  scopeRevision: number;
  older: boolean;
}

export interface ContactHistoryState {
  revision: number;
  contactId: string | null;
  scopeRevision: number;
  messages: ReplyMessagesState;
  error: string | null;
}

export interface ContactHistoryBridge {
  getState(): Promise<ContactHistoryState>;
  load(request: ContactHistoryRequest): Promise<void>;
  onStateChanged(listener: (state: ContactHistoryState) => void): () => void;
}
