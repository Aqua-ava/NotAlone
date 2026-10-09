import type { ContactSessionState } from './contact-session-bridge';

export type ForegroundPhase = 'idle' | 'observing' | 'confirmed' | 'manual-required' | 'paused' | 'unavailable';
export type GenerationBlock = 'foreground-confirmation-required' | null;
export interface ForegroundConfirmation {
  contactId: string;
  contactScopeRevision: number;
  foregroundRevision: number;
}
export interface ForegroundState {
  revision: number;
  foregroundRevision: number;
  phase: ForegroundPhase;
  reason: string | null;
  observedAt: string | null;
  probeAvailable: boolean | null;
  wechatInFront: boolean | null;
  suspendedByHelperFocus: boolean;
  confirmation: 'required' | 'manual-confirmed' | 'verified-binding';
  confirmedContactId: string | null;
  generationBlock: GenerationBlock;
}
export const initialForegroundState: ForegroundState = Object.freeze({
  revision: 0, foregroundRevision: 0, phase: 'idle', reason: null,
  observedAt: null, probeAvailable: null, wechatInFront: null, suspendedByHelperFocus: false,
  confirmation: 'required', confirmedContactId: null, generationBlock: 'foreground-confirmation-required',
});
export interface ForegroundBridge {
  getState(): Promise<ForegroundState>;
  confirm(selection: ForegroundConfirmation): Promise<ContactSessionState>;
  onStateChanged(listener: (state: ForegroundState) => void): () => void;
}
