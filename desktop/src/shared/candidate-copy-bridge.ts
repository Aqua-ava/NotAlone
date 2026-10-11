import type { ReplyCandidateSelection } from './reply-bridge';

export type CandidateCopyRequest = ReplyCandidateSelection & { hideAfterCopy: boolean } & (
  { versionId: string; messageId: string } | { versionId?: never; messageId?: never }
);
export interface CandidateCopyBridge { copy(request: CandidateCopyRequest): Promise<void>; }
