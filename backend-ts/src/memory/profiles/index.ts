/**
 * memory/profiles 的唯一对外入口：L3 长期背景的内存工作区、模型提案循环、独立核验与文档校验。
 * 目录外一律从这里导入；内部文件（document/workspace/agent/verification/shared）可随时重排。
 */
export {L3ProfileWorkspace} from './workspace.ts';
export {runProfileDocumentAgent, L3ProfileDocumentError} from './agent.ts';
export type {L3ProfileRunResult, L3ProfileRoundTrace, L3ProfileToolTrace} from './agent.ts';
export {verifyProfileProposal, L3ProfileVerificationError} from './verification.ts';
export type {L3ProfileVerificationAttemptTrace} from './verification.ts';
export {
  validateProfile,
  validateIncrementalProfile,
  filterProfileProposal,
  selectProfilePublication,
  renderProfile,
} from './document.ts';
export type {L3ProfileDocument, L3ProfileEntry, ProfileVerification} from './document.ts';
