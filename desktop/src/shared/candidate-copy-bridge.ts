import type { ReplyCandidateSelection } from './reply-bridge';

export interface CandidateCopyRequest extends ReplyCandidateSelection { hideAfterCopy: boolean; }
export interface CandidateCopyBridge { copy(request: CandidateCopyRequest): Promise<void>; }
