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
export interface ForegroundBridge {
  getState(): Promise<ForegroundState>;
  onStateChanged(listener: (state: ForegroundState) => void): () => void;
}
