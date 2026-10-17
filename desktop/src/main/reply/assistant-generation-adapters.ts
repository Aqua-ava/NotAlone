import type { ReplyInputSnapshot } from '../../shared/reply-bridge';
import { generateReply, replaceReply, retryInterruptedReply, type InterruptedReplyOrigin } from './client';
import { actOnExploration, prepareExplorationAction, type ExplorationAction, type ExplorationOutcome } from './exploration-client';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import { continueAssistantSession, type AssistantContinuationCommand } from './assistant-continuation';
import type { AssistantGenerationOwner, AssistantGenerationReceipt } from './assistant-generation-jobs';
import type { GenerationAdapter, GenerationProtocol } from './assistant-generation-execution';
import { readAssistantSession } from './assistant-sessions';

async function verifyReceivedFailure(backend: BackendHost, owner: AssistantGenerationOwner,
  error: unknown, protocol: GenerationProtocol): Promise<undefined> {
  if (!(error instanceof BackendRequestFailure) || error.kind !== 'response' || !protocol.receipt
    || protocol.signal.aborted || owner.connectionGeneration !== backend.getConnectionGeneration()) return;
  const receipt = protocol.receipt;
  try {
    const saved = await readAssistantSession(backend, owner.contactId, owner.sessionId, protocol.signal);
    const failed = saved.turns.find((turn) => turn.turnId === receipt.turnId
      && turn.inputVersionId === receipt.inputVersionId && turn.requestKey === receipt.requestKey && turn.state === 'failed');
    if (saved.generation === owner.connectionGeneration && saved.generation === backend.getConnectionGeneration()
      && !protocol.signal.aborted && protocol.active && failed) {
      protocol.observe({ kind: 'failed', canRetry: error.code === 'reply_timeout'
        || error.code === 'assistant_session_save_failed' || (error.status ?? 0) >= 500, generationActive: failed.generationActive });
    }
  } catch { /* 未知读取不能证明失败，保留原停止身份。 */ }
}

export function continuationGeneration(backend: BackendHost, owner: AssistantGenerationOwner,
  command: AssistantContinuationCommand): GenerationAdapter<Awaited<ReturnType<typeof continueAssistantSession>>> {
  return {
    async run(protocol) {
      const value = await continueAssistantSession(backend, owner.contactId, owner.sessionId, command, protocol.signal,
        protocol.prepared, protocol.requested, protocol.preparing,
        (proof) => protocol.notReserved(proof, backend.getConnectionGeneration()));
      if (value.phase === 'completed') return { value, outcome: 'completed' };
      if (value.generation !== owner.connectionGeneration) return { value, outcome: 'unknown' };
      if (protocol.receipt) throw new Error('本次澄清与实际领取状态不一致，请重新读取讨论。');
      return { value, outcome: 'no_generation' };
    },
    verifyFailure: (error, protocol) => verifyReceivedFailure(backend, owner, error, protocol),
  };
}

export function strategyGeneration(backend: BackendHost, owner: AssistantGenerationOwner,
  request: ExplorationAction): GenerationAdapter<ExplorationOutcome> {
  return {
    async run(protocol) {
      const prepared = await prepareExplorationAction(backend, request, protocol.signal);
      if (prepared.kind !== 'prepared') return { value: prepared, outcome: 'no_generation' };
      if (prepared.generation !== owner.connectionGeneration) throw new Error('本次候选准备归属尚未确认。');
      await protocol.prepared(prepared.receipt);
      if (protocol.signal.aborted || owner.connectionGeneration !== backend.getConnectionGeneration()) {
        throw new BackendRequestFailure('cancelled');
      }
      const executing = actOnExploration(backend, request, protocol.signal, prepared.receipt);
      protocol.requested();
      const value = await executing;
      if (value.kind !== 'generated' || value.taskId !== prepared.taskId) throw new Error('本次确认结果不属于原准备任务。');
      return { value, outcome: 'completed' };
    },
    async verifyFailure(error, protocol) {
      if (!protocol.job && !protocol.receipt && error instanceof BackendRequestFailure
        && error.kind === 'response' && error.noGeneration) {
        protocol.notReserved(error.noGeneration, backend.getConnectionGeneration());
      }
      return verifyReceivedFailure(backend, owner, error, protocol);
    },
  };
}

export interface OrdinaryGenerationAttempt {
  input: ReplyInputSnapshot;
  requestKey: string;
  expectedInputVersionId?: string;
  interrupted?: InterruptedReplyOrigin;
  adoptNewMessageId?: string;
}
export interface OrdinaryFailureObservation {
  receipt: AssistantGenerationReceipt | undefined;
  receiptSessionId: string | undefined;
  saved: Awaited<ReturnType<typeof readAssistantSession>> | undefined;
  readFailure: BackendRequestFailure | 'unavailable' | undefined;
}

export type OrdinaryGenerationResult = Awaited<ReturnType<typeof generateReply>> | Awaited<ReturnType<typeof retryInterruptedReply>>;

export function ordinaryGeneration(backend: BackendHost, owner: AssistantGenerationOwner,
  attempt: OrdinaryGenerationAttempt, replacementKey?: string,
  budgetVisible: () => boolean = () => true): GenerationAdapter<OrdinaryGenerationResult, OrdinaryFailureObservation> {
  return {
    async run(protocol) {
      const adoption = attempt.adoptNewMessageId === undefined ? undefined
        : Object.freeze({ adoptNewMessageId: attempt.adoptNewMessageId, expectedInputVersionId: attempt.expectedInputVersionId });
      const notReserved = (proof: import('../../shared/assistant-no-generation').AssistantNoGenerationProof) =>
        protocol.notReserved(proof, backend.getConnectionGeneration());
      const value = attempt.interrupted
        ? await retryInterruptedReply(backend, owner.contactId, owner.sessionId, attempt.interrupted, attempt.requestKey,
          protocol.signal, protocol.prepared, protocol.requested, protocol.preparing, notReserved)
        : replacementKey
        ? await replaceReply(backend, attempt.input, attempt.requestKey, replacementKey, protocol.signal, owner.sessionId,
          protocol.prepared, protocol.requested, protocol.preparing, notReserved, adoption)
        : await generateReply(backend, attempt.input, attempt.requestKey, protocol.signal, owner.sessionId,
          protocol.prepared, protocol.requested, attempt.expectedInputVersionId, protocol.preparing, notReserved, adoption);
      return { value, outcome: 'completed' };
    },
    async verifyFailure(error, protocol) {
      const failure = error instanceof BackendRequestFailure ? error : undefined;
      const budgetFailure = failure?.code === 'input_budget_exceeded' || failure?.code === 'input_budget_unavailable';
      const providerLimit = failure?.status === 409 && failure.code === 'provider_context_limit';
      let receipt = protocol.receipt;
      let saved: OrdinaryFailureObservation['saved'];
      let readFailure: OrdinaryFailureObservation['readFailure'];
      // 明确业务响应还须复验原租约；断开/取消不能依据历史 failed 结算。
      const terminalProofRequired = Boolean((receipt || budgetFailure) && failure?.kind === 'response'
        && failure.status !== undefined && failure.code && failure.code !== 'assistant_session_in_progress'
        && owner.connectionGeneration === backend.getConnectionGeneration());
      const receiptSessionId = receipt?.sessionId ?? (budgetFailure ? owner.sessionId : undefined);
      // 终态与预算展示共用一次权威读取；离开视图不取消租约核验。
      if (receiptSessionId && (terminalProofRequired || budgetVisible() && budgetFailure && failure?.inputBudget)) {
        try {
          const verified = await readAssistantSession(backend, owner.contactId, receiptSessionId, new AbortController().signal);
          if (!receipt && budgetFailure && verified.generation === owner.connectionGeneration) {
            const rejected = verified.turns.find((turn) => turn.requestKey === attempt.requestKey && turn.state === 'failed');
            if (rejected) {
              receipt = { sessionId: receiptSessionId, requestKey: attempt.requestKey,
                turnId: rejected.turnId, inputVersionId: rejected.inputVersionId, state: 'failed' };
              protocol.observe({ kind: 'receipt', receipt });
            }
          }
          if (budgetFailure && failure?.inputBudget) saved = verified;
          if (terminalProofRequired && receipt) {
            const actual = receipt;
            const terminal = verified.turns.find((turn) => turn.turnId === actual.turnId
              && turn.requestKey === attempt.requestKey && turn.inputVersionId === actual.inputVersionId);
            if (verified.generation === owner.connectionGeneration && owner.connectionGeneration === backend.getConnectionGeneration()
              && protocol.active && terminal) {
              if (terminal.state === 'completed') protocol.observe({ kind: 'completed' });
              else if (['redacted', 'unavailable'].includes(terminal.state) && terminal.input === null && terminal.reply === null) {
                protocol.observe({ kind: 'invalidated' });
              } else if (terminal.state === 'failed') protocol.observe({ kind: 'failed',
                canRetry: !budgetFailure && !providerLimit && (failure?.code === 'reply_timeout'
                  || failure?.code === 'assistant_session_save_failed' || (failure?.status ?? 0) >= 500),
                generationActive: terminal.generationActive });
            }
          }
        } catch (readError) {
          if (budgetFailure && failure?.inputBudget) readFailure = readError instanceof BackendRequestFailure ? readError : 'unavailable';
          if (terminalProofRequired && readError instanceof BackendRequestFailure && readError.kind === 'response'
            && readError.status === 404 && readError.code === 'not_found'
            && owner.connectionGeneration === backend.getConnectionGeneration()) protocol.observe({ kind: 'invalidated' });
        }
      }
      return { receipt, receiptSessionId, saved, readFailure };
    },
  };
}
