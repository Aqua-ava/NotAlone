import type { ContactSelection } from './contact-session-bridge';

export type ContactDeletionPhase = 'requesting' | 'fenced' | 'cleaning' | 'verifying' | 'blocked' | 'completed' | 'unconfirmed';
export interface ContactDeletionItem {
  id: string;
  operationId: string | null;
  contactId: string | null;
  displayName: string | null;
  phase: ContactDeletionPhase;
  errorCode: string | null;
}
export interface ContactDeletionState {
  revision: number;
  scopeRevision: number;
  phase: 'offline' | 'loading' | 'ready' | 'failed';
  operations: ContactDeletionItem[];
  busyId: string | null;
  error: string | null;
}
export interface ContactDeletionRequest extends ContactSelection { confirmed: true; }
export interface ContactDeletionRetry { id: string; scopeRevision: number; confirmed: true; }
export interface ContactDeletionBridge {
  getState(): Promise<ContactDeletionState>;
  refresh(): Promise<void>;
  delete(request: ContactDeletionRequest): Promise<void>;
  retry(request: ContactDeletionRetry): Promise<void>;
  onStateChanged(listener: (state: ContactDeletionState) => void): () => void;
}

const identifier = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
function confirmation(value: unknown, target: 'contactId' | 'id'): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return Object.keys(fields).length === 3 && Object.keys(fields).every(key => [target, 'scopeRevision', 'confirmed'].includes(key))
    && identifier(fields[target]) && Number.isSafeInteger(fields.scopeRevision) && (fields.scopeRevision as number) >= 0 && fields.confirmed === true;
}
export const validContactDeletionRequest = (value: unknown): value is ContactDeletionRequest => confirmation(value, 'contactId');
export const validContactDeletionRetry = (value: unknown): value is ContactDeletionRetry => confirmation(value, 'id');
