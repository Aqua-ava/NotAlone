import type { MessageQuoteSnapshot } from './message-quote';

export interface ContactHistoryRequest {
  contactId: string;
  scopeRevision: number;
  older: boolean;
}

export interface ContactHistoryImageMedia {
  state: 'pending' | 'original' | 'thumbnail_only' | 'unavailable' | 'failed' | 'cleared';
  fileId: string | null;
  mimeType: string | null;
  errorCode?: string | null;
}
export interface ContactHistoryMessage {
  messageId: string;
  speaker: 'user' | 'contact' | 'system';
  messageType: string;
  text: string | null;
  mediaPlaceholder: string | null;
  occurredAt: string | null;
  ordering?: 'verified' | 'unknown';
  displayPosition?: string;
  quoted: MessageQuoteSnapshot | null;
  imageMedia?: ContactHistoryImageMedia;
}
export interface ContactHistoryMessagesState {
  phase: 'idle' | 'loading' | 'ready' | 'failed';
  items: ContactHistoryMessage[];
  nextCursor: string | null;
}

export interface ContactHistoryState {
  revision: number;
  contactId: string | null;
  scopeRevision: number;
  messages: ContactHistoryMessagesState;
  error: string | null;
}

export interface ContactHistoryBridge {
  getState(): Promise<ContactHistoryState>;
  load(request: ContactHistoryRequest): Promise<void>;
  onStateChanged(listener: (state: ContactHistoryState) => void): () => void;
}
