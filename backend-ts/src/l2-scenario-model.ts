/** L2 单次物理模型轮次；沿用稳定 ModelHost 许可、预算、取消与最小台账。 */
import type {Context} from '@deepseek-ai/cordis';
import {
  LlmError,
  ReasoningEffortId,
  type ContentBlock,
  type LlmFailure,
} from '@deepseek-ai/dsh-llm';
import {SessionId} from '@deepseek-ai/dsh-session';
import {createConnection} from 'node:net';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import type {installModelProvider} from './model-provider.ts';
import type {ModelLedgerCost, ModelLedgerReceipt, ModelLedgerUsage} from './model-ledger.ts';
import {modelLedgerInputBudget} from './model-ledger.ts';
import {
  ExtractionModelError,
  extractionUnconfirmedRequests,
  recordExtractionModelReceipt,
  type ExtractionPermitEndpoint,
} from './extraction-model.ts';
import type {ScenarioDocumentCall, ScenarioDocumentCallPort, ScenarioDocumentCallResult} from './l2-scenario-workspace.ts';

interface PermitState {
  state: string;
  permit_id?: string;
  reason?: string;
}

function connect(endpoint: ExtractionPermitEndpoint, signal?: AbortSignal) {
  let cancellable = true;
  const socket = createConnection(endpoint.path);
  const lines = createInterface({input: socket})[Symbol.asyncIterator]();
  socket.on('error', () => {});
  const abort = () => socket.destroy();
  signal?.addEventListener('abort', abort, {once: true});
  async function exchange(value: unknown, timeout = 10_000): Promise<PermitState> {
    if (cancellable && signal?.aborted) throw new L2ScenarioModelError('l2_scenario_model_cancelled');
    socket.write(`${JSON.stringify(value)}\n`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const item = await Promise.race([
        lines.next(),
        new Promise<never>((_, reject) => {
          if (timeout) timer = setTimeout(() => {
            socket.destroy();
            reject(new L2ScenarioModelError('l2_scenario_model_ack_unknown'));
          }, timeout);
        }),
      ]);
      if (item.done || Buffer.byteLength(item.value) > 4096) {
        throw new L2ScenarioModelError('l2_scenario_model_ack_unknown');
      }
      return JSON.parse(item.value) as PermitState;
    } catch (error) {
      if (error instanceof L2ScenarioModelError) throw error;
      throw new L2ScenarioModelError('l2_scenario_model_ack_unknown', undefined, error);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    exchange,
    detachCancellation() {
      cancellable = false;
      signal?.removeEventListener('abort', abort);
    },
    close() {
      signal?.removeEventListener('abort', abort);
      socket.destroy();
    },
  };
}

function providerFailure(error: LlmError | LlmFailure): {name: 'LlmError'|'LlmFailure'; code: string; status?: number} {
  const failure = error instanceof LlmError ? error.failure : error;
  return {
    name: error instanceof LlmError ? 'LlmError' : 'LlmFailure',
    code: /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code) ? failure.code : 'PROVIDER_ERROR',
    ...(failure.status === undefined ? {} : {status: failure.status}),
  };
}

export class L2ScenarioModelError extends Error {
  readonly code: string;
  readonly receipt: ModelLedgerReceipt | null;
  constructor(code: string, receipt: ModelLedgerReceipt|null = null, cause?: unknown) {
    super(code, cause === undefined ? undefined : {cause});
    this.code = code;
    this.receipt = receipt;
    this.name = 'L2ScenarioModelError';
  }
}

export interface L2ScenarioPhysicalModel {
  call(input: ScenarioDocumentCall): Promise<ScenarioDocumentCallResult>;
}

/**
 * 每次调用都是一个已授权后台 permit、一个 prepareCall 和一个 stream；不沿用
 * 前一轮的 prepared caller，也不由框架重试。
 */
export function createL2ScenarioModel(options: {
  ctx: Context;
  provider: ReturnType<typeof installModelProvider>;
  permit: ExtractionPermitEndpoint;
  costForUsage?: (usage: ModelLedgerUsage) => ModelLedgerCost;
}): L2ScenarioPhysicalModel {
  return {
    async call(input: ScenarioDocumentCall): Promise<ScenarioDocumentCallResult> {
      input.signal.throwIfAborted();
      await input.requireCurrent();
      input.signal.throwIfAborted();
      if ((await extractionUnconfirmedRequests(options.permit, {
        owner_id: input.owner_id,
        contact_id: input.contact_id,
      })).includes(input.claim.task_id)) {
        throw new L2ScenarioModelError('l2_scenario_model_recovery_unknown');
      }
      const binding = {
        ...input.binding,
        reasoningEffort: ReasoningEffortId(input.binding.reasoningEffort),
      };
      const prepared = await options.ctx.llm.prepareCall(binding, input.signal);
      const connection = connect(options.permit, input.signal);
      const attemptId = randomUUID();
      const ledgerEntryId = input.contact_id === null ? null : randomUUID();
      let receipt: ModelLedgerReceipt | null = null;
      let call: ReturnType<typeof options.provider.beginCall> | undefined;
      let reserved = false;
      let settled = false;
      let reservationRejected = false;
      let permitHeld = false;
      let scopeDeleted = false;
      const started = Date.now();
      const blocks: ContentBlock[] = [];
      let usage: ModelLedgerUsage | null = null;
      let success = false;
      let observedFailure: {name: 'LlmError'|'LlmFailure'; code: string; status?: number} | null = null;
      try {
        const granted = await connection.exchange({
          op: 'acquire',
          token: options.permit.token,
          kind: 'background',
          attempt_id: attemptId,
          worker: {pid: process.pid, parentPid: process.ppid, executable: process.execPath},
        }, 0);
        if (granted.state !== 'granted' || !granted.permit_id) {
          throw new L2ScenarioModelError('l2_scenario_model_permit_unavailable');
        }
        permitHeld = true;
        connection.detachCancellation();
        const sessionId = SessionId(randomUUID());
        const base: ModelLedgerReceipt = {
          attempt_id: attemptId,
          permit_id: granted.permit_id,
          request_id: input.claim.task_id,
          owner_id: input.owner_id,
          contact_id: input.contact_id,
          scope_kind: input.contact_id === null ? 'owner_memory' : 'contact',
          provider: input.binding.provider,
          model: input.binding.model,
          called_at: new Date(started).toISOString(),
          latency_ms: null,
          dispatch: 'authorized_unconfirmed',
          outcome: 'pending',
          usage: null,
          cost: {status: 'unknown', amount: null, currency: null, pricing_version: null},
        };
        call = options.provider.beginCall({
          sessionId,
          attempt_id: attemptId,
          permit_id: granted.permit_id,
          binding: input.binding,
          profile: input.profile,
          requireCurrent: input.requireCurrent,
          beforeDispatch: async value => {
            receipt = {...base, input_budget: modelLedgerInputBudget(value.budget)};
            const response = await connection.exchange({
              op: 'reserve',
              token: options.permit.token,
              receipt,
              claim: input.claim,
            });
            if (response.state !== 'reserved') {
              reservationRejected = true;
              throw new L2ScenarioModelError('l2_scenario_model_reservation_rejected');
            }
            reserved = true;
            input.signal.throwIfAborted();
            await input.requireCurrent();
            input.signal.throwIfAborted();
          },
        });
        for await (const chunk of prepared.stream({
          ...prepared.config,
          sessionId,
          messages: input.messages,
          system: input.system,
          tools: input.tools,
          signal: input.signal,
        })) {
          if (chunk.type === 'block-end') blocks.push(structuredClone(chunk.block));
          if (chunk.type === 'usage') {
            usage = {
              input_tokens: chunk.usage.inputTokens + (chunk.usage.cacheReadTokens ?? 0) + (chunk.usage.cacheWriteTokens ?? 0),
              output_tokens: chunk.usage.outputTokens,
              cache_read_tokens: chunk.usage.cacheReadTokens ?? null,
              cache_write_tokens: chunk.usage.cacheWriteTokens ?? null,
            };
          }
          if (chunk.type === 'finish') {
            success = ['stop', 'tool-calls'].includes(chunk.reason.kind);
            if (!success && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
              observedFailure = providerFailure(chunk.reason.failure);
            }
          }
        }
      } catch (error) {
        if (error instanceof LlmError) observedFailure = providerFailure(error);
        else if (!(error instanceof L2ScenarioModelError)) {
          observedFailure = {name: 'LlmError', code: input.signal.aborted ? 'ABORTED' : 'STREAM_FAILED'};
        } else {
          throw error;
        }
      } finally {
        if (reserved && receipt) {
          const currentReceipt = receipt as ModelLedgerReceipt;
          const observation = call?.observation();
          const responseObserved = observation?.dispatch === 'http_accepted' || observedFailure?.status !== undefined;
          const terminal: ModelLedgerReceipt = {
            ...currentReceipt,
            ...(responseObserved && ledgerEntryId ? {ledger_entry_id: ledgerEntryId} : {}),
            latency_ms: Date.now() - started,
            dispatch: responseObserved ? 'response_observed'
              : observation?.dispatch === 'not_authorized' ? 'not_sent' : 'authorized_unconfirmed',
            outcome: success ? 'succeeded'
              : input.signal.aborted || observation?.dispatch === 'not_authorized' ? 'cancelled'
              : responseObserved ? 'failed' : 'unknown',
            usage,
            cost: usage && options.costForUsage
              ? options.costForUsage(usage)
              : currentReceipt.cost,
          };
          try {
            await recordExtractionModelReceipt(options.permit, terminal);
            const state = await connection.exchange({op: 'settled'});
            if (state.state !== 'settled') {
              throw new L2ScenarioModelError('l2_scenario_model_ack_unknown', terminal);
            }
            settled = true;
            receipt = terminal;
          } catch (error) {
            if (error instanceof ExtractionModelError && error.code === 'extraction_model_scope_deleted') {
              scopeDeleted = true;
              const state = await connection.exchange({op: 'settled'});
              if (state.state !== 'settled') {
                throw new L2ScenarioModelError('l2_scenario_model_ack_unknown', terminal);
              }
              settled = true;
              receipt = terminal;
            } else {
              if (error instanceof L2ScenarioModelError) throw error;
              throw new L2ScenarioModelError('l2_scenario_model_ack_unknown', terminal, error);
            }
          } finally {
            call?.close();
          }
        } else if (permitHeld && reservationRejected) {
          call?.close();
          try {
            const state = await connection.exchange({op: 'settled'});
            if (state.state !== 'settled') {
              throw new L2ScenarioModelError('l2_scenario_model_ack_unknown');
            }
            settled = true;
          } catch (error) {
            if (error instanceof L2ScenarioModelError) throw error;
            throw new L2ScenarioModelError('l2_scenario_model_ack_unknown', undefined, error);
          }
        } else {
          call?.close();
        }
        connection.close();
      }
      if (!settled) throw new L2ScenarioModelError('l2_scenario_model_ack_unknown', receipt);
      if (scopeDeleted) throw new L2ScenarioModelError('l2_scenario_model_scope_deleted', receipt);
      if (!success || !receipt) {
        if (input.signal.aborted) throw new L2ScenarioModelError('l2_scenario_model_cancelled', receipt);
        if (observedFailure?.code === 'CONTEXT_WINDOW_EXCEEDED') {
          throw new L2ScenarioModelError('l2_scenario_model_context_limit', receipt);
        }
        throw new L2ScenarioModelError('l2_scenario_model_failed', receipt);
      }
      input.signal.throwIfAborted();
      await input.requireCurrent();
      return {blocks, receipt_id: receipt.attempt_id};
    },
  };
}

export function createL2ScenarioCallPort(model: L2ScenarioPhysicalModel): ScenarioDocumentCallPort {
  return {call: input => model.call(input)};
}
