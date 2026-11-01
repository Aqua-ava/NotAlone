export interface CliSessionSummary {
  locator: string; displayName: string; lastTimestamp: number | null; boundContactId: string | null; selectionGeneration?: string; knownContactId?: string | null;
}
export interface BindingSummary {
  bindingId: string; contactId: string; locator: string; displayName: string | null; status: 'active' | 'revoked'; selectionGeneration?: string;
}
export interface BindingConsentState {
  revision: number; scopeRevision: number; selectionOnly?: boolean;
  phase: 'offline' | 'loading' | 'ready' | 'owner-unconfigured' | 'unavailable' | 'failed';
  // 已保存关联仅用于展示；正文授权始终只认 bindings 的 active 集合。
  knownBindings?: BindingSummary[];
  sessions: CliSessionSummary[]; bindings: BindingSummary[]; syncEnabled: boolean | null;
  sessionIssue: 'not-requested' | 'unavailable' | 'failed' | null;
  busy: 'confirm' | 'revoke' | null;
  errorCode: 'selection-stale' | 'confirmation-failed' | 'sync-start-failed' | 'revoke-busy' | 'revoke-failed' | null;
  notice: 'confirmed' | 'revoked' | null;
}
export interface BindingSelection { locator: string; displayName: string; contactId: string | null; }
export interface BindingConfirmation { scopeRevision: number; selections: BindingSelection[]; historyAuthorized?: boolean; startSync?: boolean; }
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
  const fields = value as Record<string, unknown>;
  return (!Object.hasOwn(fields, 'historyAuthorized') || typeof fields.historyAuthorized === 'boolean')
    && (!Object.hasOwn(fields, 'startSync') || typeof fields.startSync === 'boolean');
}
