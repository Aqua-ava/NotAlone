export type BackendPhase = 'disconnected' | 'connecting' | 'connected' | 'stopping' | 'shutdown-failed' | 'stopped';
export type BackendErrorCode = 'backend_launch_unconfigured' | 'backend_handshake_invalid' | 'backend_connection_failed' | 'backend_shutdown_unconfirmed';

// 这里只传递非秘密状态；认证信息和启动路径始终留在主进程。
export interface BackendState {
  phase: BackendPhase;
  errorCode?: BackendErrorCode;
  reused: boolean;
  revision: number;
  canRetryConnection: boolean;
  canRetryShutdown: boolean;
}

export interface BackendBridge {
  getState(): Promise<BackendState>;
  retryConnection(): Promise<void>;
  quit(): Promise<void>;
  onStateChanged(listener: (state: BackendState) => void): () => void;
}
