export type SetupPhase = 'offline' | 'loading' | 'needs-owner' | 'identity-unbound' | 'ready' | 'failed' | 'saving' | 'restarting' | 'restart-failed';
export interface SetupState {
  phase: SetupPhase;
  ownerReady: boolean;
  credentialsConfigured: boolean;
  revision: number;
  errorCode?: 'initialize-failed' | 'credentials-failed' | 'reload-failed';
}
export interface SetupBridge {
  getState(): Promise<SetupState>;
  refresh(): Promise<void>;
  initializeOwner(displayName: string): Promise<void>;
  saveDeepSeekKey(apiKey: string): Promise<void>;
  retryRestart(): Promise<void>;
  onStateChanged(listener: (state: SetupState) => void): () => void;
}
