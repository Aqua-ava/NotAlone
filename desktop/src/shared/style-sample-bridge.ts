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
export type CandidateTextCopy = ReplyCandidateSelection & { text: string; invalidSelection?: true };
export type CandidateVersionStyleSampleSave = ReplyCandidateSelection & { sessionId: string; versionId: string; text: string };
export type CandidateStylePaste = (ReplyCandidateSelection & { text: string }) | CandidateVersionStyleSampleSave;
export type SavedSampleTextCopy = ContactSelection & { sampleId: string; text: string };
export type ManualStyleText = ContactSelection & { text: string };
export type StylePasteReceipt = { pasteId: string };
export type ManualStyleUpdate = ManualStyleText & { pasteId?: string; pastedText?: string; insertedText?: string; cancelPasteId?: string };
export interface StyleSampleBridge {
  getState(): Promise<StyleSampleState>;
  refresh(selection: ContactSelection): Promise<void>;
  saveManual(selection: ContactSelection & { text: string }): Promise<void>;
  saveCandidate(selection: ReplyCandidateSelection | CandidateVersionStyleSampleSave): Promise<void>;
  saveMessage(selection: ContactSelection & { messageId: string }): Promise<void>;
  deleteSample(selection: ContactSelection & { sampleId: string }): Promise<void>;
  noteCandidateCopy(selection: CandidateTextCopy): Promise<void>;
  noteSavedSampleCopy(selection: SavedSampleTextCopy): Promise<void>;
  validateCandidatePaste(selection: CandidateStylePaste): Promise<void>;
  updateManualText(selection: ManualStyleUpdate): Promise<void>;
  noteManualPaste(selection: ManualStyleText): Promise<StylePasteReceipt>;
  onStateChanged(listener: (state: StyleSampleState) => void): () => void;
}
