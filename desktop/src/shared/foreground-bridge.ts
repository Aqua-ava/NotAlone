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
  recognizedName: string | null;
  recognitionConfidence: number | null;
  probeAvailable: boolean | null;
  wechatInFront: boolean | null;
  suspendedByHelperFocus: boolean;
  unsupportedConversation: boolean;
  manualInput?: boolean;
  confirmation: 'required' | 'manual-confirmed' | 'verified-binding';
  confirmedContactId: string | null;
  suggestedContactId: string | null;
  generationBlock: GenerationBlock;
}
export const initialForegroundState: ForegroundState = Object.freeze({
  revision: 0, foregroundRevision: 0, phase: 'idle', reason: null,
  observedAt: null, recognizedName: null, recognitionConfidence: null,
  probeAvailable: null, wechatInFront: null, suspendedByHelperFocus: false,
  unsupportedConversation: false,
  confirmation: 'required', confirmedContactId: null, suggestedContactId: null, generationBlock: 'foreground-confirmation-required',
});
export interface ForegroundBridge {
  getState(): Promise<ForegroundState>;
  confirm(selection: ForegroundConfirmation): Promise<ContactSessionState>;
  resume(selection: ForegroundConfirmation): Promise<ForegroundState>;
  onStateChanged(listener: (state: ForegroundState) => void): () => void;
}
