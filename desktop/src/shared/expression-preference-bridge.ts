import type { ContactSelection } from './contact-session-bridge';

export type ExpressionReplyMode = 'reply_to_message' | 'rewrite_draft' | 'initiate_conversation';
export type ExpressionPreference = {
  preferenceId: string;
  text: string;
  scope: { contactId: string | null; replyMode: ExpressionReplyMode | null };
  revision: number;
  confirmedOperationKey: string;
  origin: { kind: 'manual' } | { kind: 'message'; id: string };
  sourceIds: string[];
  confirmedAt: string;
  updatedAt: string;
};
export type ExpressionPreferenceReceipt = Pick<ExpressionPreference, 'preferenceId' | 'text' | 'scope' | 'revision'>;
export type ExpressionPreferenceState = {
  revision: number;
  erasureRevision: number;
  contactId: string | null;
  scopeRevision: number;
  phase: 'idle' | 'loading' | 'ready' | 'error';
  preferences: ExpressionPreference[];
  busy: boolean;
  error: string | null;
};
export type ExpressionPreferenceSave = ContactSelection & {
  text: string;
  appliesTo: 'owner' | 'contact';
  replyMode: ExpressionReplyMode | null;
  confirmLongTerm: boolean;
};
export type ExpressionPreferenceUpdate = ExpressionPreferenceSave & { preferenceId: string; expectedRevision: number };
export type ExpressionPreferenceRemoval = ContactSelection & { preferenceId: string; expectedRevision: number };
export type ExpressionPreferenceBridge = {
  getState(): Promise<ExpressionPreferenceState>;
  refresh(selection: ContactSelection): Promise<void>;
  save(request: ExpressionPreferenceSave): Promise<void>;
  update(request: ExpressionPreferenceUpdate): Promise<void>;
  remove(request: ExpressionPreferenceRemoval): Promise<void>;
  onStateChanged(listener: (state: ExpressionPreferenceState) => void): () => void;
};
