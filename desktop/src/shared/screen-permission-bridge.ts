export interface ScreenPermissionState {
  phase: 'idle' | 'checking' | 'granted' | 'missing' | 'unavailable';
  busy: boolean;
  revision: number;
}
export const initialScreenPermissionState: ScreenPermissionState = { phase: 'idle', busy: false, revision: 0 };
export interface ScreenPermissionBridge {
  getState(): Promise<ScreenPermissionState>;
  request(): Promise<ScreenPermissionState>;
  recheck(): Promise<ScreenPermissionState>;
  onStateChanged(listener: (state: ScreenPermissionState) => void): () => void;
}
