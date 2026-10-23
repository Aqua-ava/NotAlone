export interface CliSessionSummary {
  locator: string; displayName: string; lastTimestamp: number | null; boundContactId: string | null;
}
export interface BindingSummary {
  bindingId: string; contactId: string; locator: string; displayName: string | null; status: 'active' | 'revoked';
}
export interface BindingConsentState {
  revision: number; scopeRevision: number;
  phase: 'offline' | 'loading' | 'ready' | 'owner-unconfigured' | 'unavailable' | 'failed';
  // 已保存关联仅用于展示；正文授权始终只认 bindings 的 active 集合。
  knownBindings?: BindingSummary[];
  sessions: CliSessionSummary[]; bindings: BindingSummary[]; syncEnabled: boolean | null;
  sessionIssue: 'not-requested' | 'unavailable' | 'failed' | null;
  busy: 'confirm' | 'revoke' | null;
  errorCode: 'selection-stale' | 'confirmation-failed' | 'revoke-busy' | 'revoke-failed' | null;
  notice: 'confirmed' | 'revoked' | null;
}
export interface BindingSelection { locator: string; displayName: string; contactId: string | null; }
export interface BindingConfirmation { scopeRevision: number; selections: BindingSelection[]; historyAuthorized?: boolean; }
export interface BindingRevocation { scopeRevision: number; contactId: string; bindingId: string; }
export interface BindingConsentBridge {
  getState(): Promise<BindingConsentState>;
  refresh(): Promise<void>;
  refreshSaved(): Promise<void>;
  confirmSelections(confirmation: BindingConfirmation): Promise<void>;
  revokeBinding(revocation: BindingRevocation): Promise<void>;
  onStateChanged(listener: (state: BindingConsentState) => void): () => void;
}

// 旧调用未提供历史选择时仅授权增量；存在字段时必须为明确布尔值。
export function validBindingHistoryChoice(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return !Object.hasOwn(value, 'historyAuthorized') || typeof (value as Record<string, unknown>).historyAuthorized === 'boolean';
}
