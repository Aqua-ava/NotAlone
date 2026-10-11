import type { ContactSelection } from './contact-session-bridge';

export interface AssistantCandidateMessage { messageId: string; text: string; }
export interface AssistantCandidateVersion {
  versionId: string;
  versionNumber: number;
  parentVersionId: string | null;
  text: string;
  messages: AssistantCandidateMessage[];
  requirements: string | null;
  createdAt: string;
}
export interface AssistantCandidateHistory {
  sessionId: string;
  turnId: string;
  candidateId: string;
  candidateGroupId: string;
  candidateNumber: number;
  defaultDisplayVersionId: string;
  selectedVersionId: string | null;
  versions: AssistantCandidateVersion[];
}
export interface AssistantCandidateSelection {
  selectionId: string;
  selectionNumber: number;
  sessionId: string;
  candidateId: string;
  versionId: string;
}
export interface AssistantCandidateVersionView {
  candidateId: string;
  phase: 'loading' | 'ready' | 'saving' | 'failed';
  history: AssistantCandidateHistory | null;
  displayVersionId: string | null;
}
export interface AssistantCandidateVersionsState {
  phase: 'idle' | 'loading' | 'ready' | 'failed';
  sessionId: string | null;
  items: AssistantCandidateVersionView[];
}
export interface ExplicitAssistantCandidateSelection {
  phase: 'idle' | 'loading' | 'ready' | 'saving' | 'failed';
  selection: AssistantCandidateSelection | null;
}
export interface ReplyCandidateVersionRead extends ContactSelection {
  sessionId: string;
  candidateId: string;
}
export interface ReplyCandidateVersionEdit extends ReplyCandidateVersionRead {
  editKey: string;
  parentVersionId: string;
  messages: AssistantCandidateMessage[];
  requirements: string | null;
}
export interface ReplyCandidateVersionDisplay extends ReplyCandidateVersionRead { versionId: string; }
export interface ReplyCandidateVersionSelection extends ReplyCandidateVersionDisplay { selectionKey: string; }
