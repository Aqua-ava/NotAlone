export type WechatSetupPhase = 'offline' | 'loading' | 'failed' | 'saving' | 'restarting' | 'restart-failed'
  | 'needs_detection' | 'needs_owner' | 'tool_unavailable' | 'tool_not_ready' | 'ready' | 'connected' | 'restart_required' | 'conflict';
export interface WechatSetupState {
  phase: WechatSetupPhase;
  accountId: string | null;
  failureCode: string | null;
  revision: number;
}
export interface WechatSetupConfirmation {
  revision: number;
  confirmed: true;
  mode: 'selected' | 'all_private';
  historyAuthorized: boolean;
}
export function validWechatSetupConfirmation(value: unknown): value is WechatSetupConfirmation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return Object.keys(fields).length === 4
    && ['revision', 'confirmed', 'mode', 'historyAuthorized'].every(key => Object.hasOwn(fields, key))
    && fields.confirmed === true && Number.isSafeInteger(fields.revision) && (fields.revision as number) >= 0
    && (fields.mode === 'selected' || fields.mode === 'all_private') && typeof fields.historyAuthorized === 'boolean';
}
export interface WechatSetupBridge {
  getState(): Promise<WechatSetupState>;
  refresh(): Promise<void>;
  detect(): Promise<void>;
  confirm(request: WechatSetupConfirmation): Promise<void>;
  retryRestart(): Promise<void>;
  onStateChanged(listener: (state: WechatSetupState) => void): () => void;
}
