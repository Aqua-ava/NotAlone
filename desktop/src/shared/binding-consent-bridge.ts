export interface CliSessionSummary {
  locator: string; displayName: string; lastTimestamp: number | null; boundContactId: string | null;
}
export interface BindingSummary {
  bindingId: string; contactId: string; locator: string; displayName: string | null; status: 'active' | 'revoked';
}
export interface BindingConsentState {
  revision: number; scopeRevision: number;
  phase: 'offline' | 'loading' | 'ready' | 'owner-unconfigured' | 'unavailable' | 'failed';
  sessions: CliSessionSummary[]; bindings: BindingSummary[]; syncEnabled: boolean | null;
  sessionIssue: 'not-requested' | 'unavailable' | 'failed' | null;
  busy: 'confirm' | 'revoke' | null;
  errorCode: 'selection-stale' | 'confirmation-failed' | 'revoke-busy' | 'revoke-failed' | null;
  notice: 'confirmed' | 'revoked' | null;
}
export interface BindingSelection { locator: string; displayName: string; contactId: string | null; }
export interface BindingConfirmation { scopeRevision: number; selections: BindingSelection[]; }
export interface BindingRevocation { scopeRevision: number; contactId: string; bindingId: string; }
export interface BindingConsentBridge {
  getState(): Promise<BindingConsentState>;
  refresh(): Promise<void>;
  confirmSelections(confirmation: BindingConfirmation): Promise<void>;
  revokeBinding(revocation: BindingRevocation): Promise<void>;
  onStateChanged(listener: (state: BindingConsentState) => void): () => void;
}
