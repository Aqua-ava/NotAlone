export type WechatSetupPhase = 'offline' | 'loading' | 'failed' | 'saving' | 'restarting' | 'restart-failed'
  | 'needs_detection' | 'needs_owner' | 'tool_unavailable' | 'tool_not_ready' | 'ready' | 'connected' | 'restart_required' | 'conflict';
export interface WechatSetupState {
  phase: WechatSetupPhase;
  accountId: string | null;
  failureCode: string | null;
  revision: number;
}
export interface WechatSetupConfirmation { revision: number; confirmed: true }
export interface WechatSetupBridge {
  getState(): Promise<WechatSetupState>;
  refresh(): Promise<void>;
  detect(): Promise<void>;
  confirm(request: WechatSetupConfirmation): Promise<void>;
  retryRestart(): Promise<void>;
  onStateChanged(listener: (state: WechatSetupState) => void): () => void;
}
