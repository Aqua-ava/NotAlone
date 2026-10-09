export type ForegroundPhase = 'idle' | 'observing' | 'confirmed' | 'manual-required' | 'paused' | 'unavailable';
export interface ForegroundState {
  revision: number;
  foregroundRevision: number;
  phase: ForegroundPhase;
  reason: string | null;
  observedAt: string | null;
  probeAvailable: boolean | null;
  wechatInFront: boolean | null;
  suspendedByHelperFocus: boolean;
}
export const initialForegroundState: ForegroundState = Object.freeze({
  revision: 0, foregroundRevision: 0, phase: 'idle', reason: null,
  observedAt: null, probeAvailable: null, wechatInFront: null, suspendedByHelperFocus: false,
});
export interface ForegroundBridge {
  getState(): Promise<ForegroundState>;
  onStateChanged(listener: (state: ForegroundState) => void): () => void;
}
