import type { ReplyCandidateSelection } from './reply-bridge';

export type CandidateTextCopy = ReplyCandidateSelection & { text: string; invalidSelection?: true };
export type CandidateTextPaste = ReplyCandidateSelection & { text: string; sessionId?: string; versionId?: string };
export interface CandidateProvenanceBridge {
  noteCandidateCopy(selection: CandidateTextCopy): Promise<void>;
  validateCandidatePaste(selection: CandidateTextPaste): Promise<void>;
}
