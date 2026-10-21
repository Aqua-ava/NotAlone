import type { ReplyFailureCode } from './reply-bridge';

// 桌面与后端回复契约的单一来源：文本上限以后端 reply/interface.py 为准，
// 失败码与原因到界面语义的映射只在这里维护一份。
export const replyTextLimit = 4096;

export type ReplyFailureEvidence = {
  kind?: 'connection' | 'response' | 'cancelled';
  code?: string;
  reason?: string;
  inputBudgetState?: 'exceeded' | 'unavailable';
  providerLimit?: boolean;
  formatFailure?: boolean;
};

export type ReplyFailureDecision = { errorCode: ReplyFailureCode; canRetry: boolean; known: boolean };

const candidateRejectedCodes = new Set(['reply_candidates_rejected']);
const timeoutCodes = new Set(['reply_timeout', 'assistant_preparation_timeout']);
const rejectedCodes = new Set(['reply_rejected', 'assistant_session_rejected']);
const unavailableCodes = new Set(['reply_unavailable', 'runtime_stopping', 'assistant_preparation_busy']);
const sourceUnavailableReasons = new Set(['source_unavailable', 'source_deleted']);

// 已知码按固定分类映射；其余显式标记 known=false，由调用方记录并按可重试的未知失败处理，
// 不再用嵌套三元静默折叠成 generation_failed。
export function replyFailureDecision(evidence: ReplyFailureEvidence): ReplyFailureDecision {
  const { kind, code, reason, inputBudgetState, providerLimit = false, formatFailure = false } = evidence;
  if (kind === 'connection') return { errorCode: 'connection', canRetry: true, known: true };
  if (code && candidateRejectedCodes.has(code)) return { errorCode: 'candidates_rejected', canRetry: false, known: true };
  if (inputBudgetState) return { errorCode: inputBudgetState === 'exceeded' ? 'input_budget_exceeded' : 'input_budget_unavailable', canRetry: false, known: true };
  if (providerLimit) return { errorCode: 'provider_context_limit', canRetry: false, known: true };
  if (formatFailure) {
    return reason === 'prepared_context_generation_running'
      ? { errorCode: 'prepared_context_running', canRetry: false, known: true }
      : reason === 'prepared_context_generation_unconfirmed'
        ? { errorCode: 'prepared_context_unconfirmed', canRetry: false, known: true }
        : { errorCode: 'prepared_context_reprepare_required', canRetry: false, known: true };
  }
  if (code && timeoutCodes.has(code)) return { errorCode: 'timeout', canRetry: true, known: true };
  if (code === 'assistant_session_save_failed') return { errorCode: 'save_failed', canRetry: true, known: true };
  if (reason === 'target_message_unavailable') return { errorCode: 'target_unavailable', canRetry: true, known: true };
  if (reason && sourceUnavailableReasons.has(reason)) return { errorCode: 'source_unavailable', canRetry: true, known: true };
  if (code && rejectedCodes.has(code)) return { errorCode: 'rejected', canRetry: true, known: true };
  if (code && unavailableCodes.has(code)) return { errorCode: 'unavailable', canRetry: true, known: true };
  return { errorCode: 'generation_failed', canRetry: true, known: false };
}
