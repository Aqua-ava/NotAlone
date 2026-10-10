import type { ContactSelection } from './contact-session-bridge';
import type { ReplyCandidateSelection } from './reply-bridge';

export interface StyleSample {
  sampleId: string; text: string; originKind: 'manual' | 'candidate' | 'message';
  originId: string | null; sourceIds: string[]; savedAt: string; sendingStatus: 'unknown';
}
export interface StyleSampleState {
  revision: number; contactId: string | null; scopeRevision: number;
  erasureRevision: number;
  phase: 'idle' | 'loading' | 'ready' | 'failed'; samples: StyleSample[];
  busy: boolean; error: string | null;
}
export interface StyleSampleBridge {
  getState(): Promise<StyleSampleState>;
  refresh(selection: ContactSelection): Promise<void>;
  saveManual(selection: ContactSelection & { text: string }): Promise<void>;
  saveCandidate(selection: ReplyCandidateSelection): Promise<void>;
  saveMessage(selection: ContactSelection & { messageId: string }): Promise<void>;
  deleteSample(selection: ContactSelection & { sampleId: string }): Promise<void>;
  onStateChanged(listener: (state: StyleSampleState) => void): () => void;
}
