import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import { isUuid } from '../uuid';
import { isRecord, readReplyResult } from './result-read';
import { readAssistantGenerationReceipt, type AssistantGenerationReceipt } from './assistant-generation-jobs';
import type { AssistantNoGenerationProof } from '../../shared/assistant-no-generation';
import { readReplyScene } from './scene';
import { ASSISTANT_CONTINUATION_RESPONSE_LIMIT, readAssistantContinuationClarification,
  type RequirementChange, type RequirementClarificationOption } from '../../shared/assistant-continuation-clarification';
export { readAssistantContinuationClarification } from '../../shared/assistant-continuation-clarification';
export type { RequirementChange, RequirementClarificationOption, AssistantContinuationClarification } from '../../shared/assistant-continuation-clarification';



export interface ShownCandidateVersion { readonly number: number; readonly candidateId: string; readonly versionId: string; }
export interface DisplayedCandidateGroup {
  readonly sessionId: string;
  readonly candidateGroupId: string;
  readonly candidates: readonly ShownCandidateVersion[];
}
const characterCount = (value: string): number => Array.from(value).length;
// 新要求明确add；keep/remove只引用已存在的要求，避免回声式提交失效的previous。
export function requirementChangeFromClarification(option: RequirementClarificationOption,
  action: RequirementChange['action'], replacement?: string): RequirementChange {
  if (option.origin === 'new') {
    if (action !== 'add' || replacement !== undefined) throw new Error('请明确新增这条要求。');
    return { action: 'add', replacement: option.requirement };
  }
  if (action === 'keep' || action === 'remove') return { action, previous: option.requirement };
  if (action !== 'replace' || typeof replacement !== 'string' || !replacement.trim() || characterCount(replacement) > 4096) {
    throw new Error('请明确替换后的要求。');
  }
  return { action: 'replace', previous: option.requirement, replacement: replacement.trim() };
}

export interface AssistantContinuationCommand {
  readonly requestKey: string;
  readonly expectedInputVersionId: string;
  readonly instruction: string;
  readonly displayedGroup: DisplayedCandidateGroup;
  readonly intentionUpdate?: string;
  readonly requirementChanges?: readonly RequirementChange[];
}

// 由实际显示/明确选组的控制器调用；不从生成时间、复制动作或默认首条推断。
export function captureDisplayedCandidateGroup(sessionId: string, candidateGroupId: string,
  shown: readonly ShownCandidateVersion[]): DisplayedCandidateGroup {
  if (!isUuid(sessionId) || !isUuid(candidateGroupId) || !Array.isArray(shown) || shown.length > 3) {
    throw new Error('请重新显示本会话的一组候选。');
  }
  const numbers = new Set<number>(); const candidates = new Set<string>();
  const captured = shown.map((item) => {
    if (!Number.isInteger(item.number) || item.number < 1 || item.number > 3
      || !isUuid(item.candidateId) || !isUuid(item.versionId) || numbers.has(item.number)
      || candidates.has(item.candidateId.toLowerCase())) throw new Error('候选展示身份不明确，请重新选择。');
    numbers.add(item.number); candidates.add(item.candidateId.toLowerCase());
    return Object.freeze({ number: item.number, candidateId: item.candidateId.toLowerCase(), versionId: item.versionId.toLowerCase() });
  });
  return Object.freeze({ sessionId: sessionId.toLowerCase(), candidateGroupId: candidateGroupId.toLowerCase(),
    candidates: Object.freeze(captured) });
}

function requestBody(command: AssistantContinuationCommand, sessionId: string) {
  if (!isUuid(command.requestKey) || !isUuid(command.expectedInputVersionId)
    || typeof command.instruction !== 'string' || !command.instruction.trim() || characterCount(command.instruction) > 4096) {
    throw new Error('请明确本次继续的要求。');
  }
  const frame = captureDisplayedCandidateGroup(command.displayedGroup.sessionId, command.displayedGroup.candidateGroupId,
    command.displayedGroup.candidates);
  if (frame.sessionId !== sessionId) throw new Error('请在当前助手会话中选择候选。');
  return { idempotency_key: command.requestKey.toLowerCase(), expected_input_version_id: command.expectedInputVersionId.toLowerCase(),
    instruction: command.instruction.trim(), displayed_group: { session_id: frame.sessionId,
      candidate_group_id: frame.candidateGroupId, candidates: frame.candidates.map((item) => ({ number: item.number,
        candidate_id: item.candidateId, version_id: item.versionId })) },
    ...(command.intentionUpdate === undefined ? {} : { intention_update: command.intentionUpdate }),
    ...(command.requirementChanges === undefined ? {} : { requirement_changes: structuredClone(command.requirementChanges) }),
  };
}

// 复用唯一认证传输；结果归属、候选版本与生效要求均由后端同事务确定。
export async function continueAssistantSession(backend: BackendHost, contactId: string, sessionId: string,
  command: AssistantContinuationCommand, signal: AbortSignal,
  onPrepared?: (receipt: AssistantGenerationReceipt) => void | Promise<void>, onRequested?: () => void,
  onPrepareRequest?: () => void, onNoGeneration?: (proof: AssistantNoGenerationProof) => void) {
  if (!isUuid(contactId) || !isUuid(sessionId)) throw new Error('当前助手会话身份无效。');
  const body = requestBody(command, sessionId.toLowerCase());
  const request = { method: 'POST' as const,
    path: `/api/contacts/${contactId.toLowerCase()}/assistant-sessions/${sessionId.toLowerCase()}/continue`,
    body, timeoutMs: 25_000, maxResponseBytes: ASSISTANT_CONTINUATION_RESPONSE_LIMIT, signal, acceptAssistantContinuationClarification: true as const };
  const generation = backend.getConnectionGeneration();
  const perform = async (path: string) => {
    try { return await backend.requestJson({ ...request, path,
      ...(path === request.path + '/prepare' ? { acceptAssistantNoGenerationProof: true as const } : {}) }); }
    catch (error) {
      if (error instanceof BackendRequestFailure && error.status === 409
        && error.code === 'assistant_continuation_clarification_required') {
        throw new Error('本次澄清内容尚未读到，请重新提交。');
      }
      throw error;
    }
  };
  const clarified = (value: unknown, responseGeneration: number) => {
    if (!(isRecord(value) && value.error === 'assistant_continuation_clarification_required')) return undefined;
    const clarification = readAssistantContinuationClarification(value);
    if (!clarification) throw new Error('本次澄清格式无效，请重新提交。');
    return { phase: 'clarification' as const, clarification, generation: responseGeneration,
      contactId: contactId.toLowerCase(), assistantSessionId: sessionId.toLowerCase(),
      expectedInputVersionId: body.expected_input_version_id, requestKey: body.idempotency_key,
      message: clarification.reason === 'intention_conflict'
        ? '本次文字要求与明确意愿不一致，请改为同一意愿后重新提交。'
        : '请明确选择候选；旧要求可以保留、替换或移除，新要求需明确新增。' };
  };
  const preparing = perform(request.path + '/prepare');
  onPrepareRequest?.();
  let preparation: Awaited<ReturnType<typeof perform>>;
  try { preparation = await preparing; }
  catch (error) {
    if (error instanceof BackendRequestFailure && error.noGeneration && generation !== undefined
      && backend.getConnectionGeneration() === generation
      && error.noGeneration.contactId === contactId.toLowerCase() && error.noGeneration.sessionId === sessionId.toLowerCase()
      && error.noGeneration.requestKey === body.idempotency_key) onNoGeneration?.(error.noGeneration);
    throw error;
  }
  const preparationClarification = clarified(preparation.data, preparation.generation);
  if (preparationClarification) return preparationClarification;
  if (generation === undefined || preparation.generation !== generation
    || backend.getConnectionGeneration() !== generation) throw new Error('本次生成连接已变化。');
  const receipt = readAssistantGenerationReceipt(preparation.data, sessionId.toLowerCase(), body.idempotency_key);
  await onPrepared?.(receipt);
  if (signal.aborted) throw new BackendRequestFailure('cancelled');
  const execution = perform(request.path);
  onRequested?.();
  const response = await execution;
  const value = response.data;
  const executionClarification = clarified(value, response.generation);
  if (executionClarification) return executionClarification;
  if (!isRecord(value) || value.session_id !== sessionId.toLowerCase() || value.state !== 'completed'
    || value.input_version_id !== receipt.inputVersionId || value.turn_id !== receipt.turnId
    || response.generation !== generation || backend.getConnectionGeneration() !== generation
    || !isUuid(value.input_version_id) || !isRecord(value.continuation) || !isRecord(value.effective_input)) {
    throw new Error('本次继续尚未可靠保存。');
  }
  const continuation = value.continuation;
  if (continuation.candidate_group_id !== body.displayed_group.candidate_group_id
    || !Array.isArray(continuation.effective_requirements)
    || !continuation.effective_requirements.every((item) => typeof item === 'string' && Boolean(item.trim()))
    || !isRecord(continuation.effective_intent)
    || !['draft_text', 'direction', 'purpose'].includes(continuation.effective_intent.source as string)) {
    throw new Error('本次生效要求格式无效。');
  }
  const candidateId = continuation.candidate_id; const versionId = continuation.version_id;
  if (candidateId !== null || versionId !== null) {
    if (!isUuid(candidateId) || !isUuid(versionId) || !body.displayed_group.candidates.some((item) =>
      item.number === continuation.candidate_number && item.candidate_id === candidateId && item.version_id === versionId)) {
      throw new Error('本次继续的候选版本身份不一致。');
    }
  }
  return { phase: 'completed' as const, ...readReplyResult(value), generation: response.generation,
    assistantSessionId: sessionId.toLowerCase(), inputVersionId: value.input_version_id.toLowerCase(),
    resolvedCandidateId: candidateId as string | null, resolvedVersionId: versionId as string | null,
    effectiveRequirements: [...continuation.effective_requirements] as string[], effectiveInput: value.effective_input,
    effectiveScene: readReplyScene(value.effective_scene) };
}
