import type { AssistantNoGenerationProof } from '../../shared/assistant-no-generation';
import type { SavedAssistantTurn } from '../../shared/assistant-session';
import type { ReplyInputSnapshot } from '../../shared/reply-bridge';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import { isUuid } from '../uuid';
import { defaultAssistantSession } from './assistant-sessions';
import { isRecord, readReplyResult } from './result-read';
import { readAssistantGenerationReceipt, type AssistantGenerationReceipt } from './assistant-generation-jobs';
import { sceneSnapshot } from './scene';

export type ReplyRequestOptions = Readonly<{ adoptNewMessageId?: string; expectedInputVersionId?: string }>;

// prepare 与实际生成共用同一规范正文，不能在两段调用之间从当前界面重新取输入。
export function replyRequestBody(input: ReplyInputSnapshot, requestKey: string, options?: ReplyRequestOptions) {
  const expected = options?.expectedInputVersionId, adopted = options?.adoptNewMessageId;
  if (expected !== undefined && !isUuid(expected)) throw new Error('本次重试输入已变化。');
  if (adopted !== undefined && (!isUuid(adopted) || expected === undefined || input.mode === 'rewrite_draft'
    || input.mode === 'reply_to_message' && input.target.messageId.toLowerCase() !== adopted.toLowerCase())) {
    throw new Error('本次新消息采用身份无效。');
  }
  const instruction = adopted === undefined ? input.userInstruction : null;
  const content = input.mode === 'rewrite_draft' ? {
    type: 'rewrite_draft', draft_text: input.draftText, user_instruction: instruction,
    include_relationship_context: input.includeRelationshipContext,
    ...(input.inputKind === 'workspace' ? { input_kind: 'workspace', workspace_action: input.workspaceAction,
      ...(input.contextText ? { context_text: input.contextText } : {}),
      ...(input.excludedMessageIds?.length ? { excluded_message_ids: [...input.excludedMessageIds] } : {}) } : {}),
    ...(input.inputKind === 'current_chat' ? { input_kind: 'current_chat', pasted_direction: input.pastedDirection } : {}),
  } : input.mode === 'initiate_conversation' ? {
    type: 'initiate_conversation', purpose: input.purpose, understanding_correction: input.correction || null,
    user_instruction: instruction || null, clarification_answer: input.clarificationAnswer || null,
  } : {
    type: 'reply_to_message', target_message_id: input.target.messageId, direction: input.direction, direction_source: 'direct_input',
    understanding_correction: input.correction || null, user_instruction: instruction || null,
    clarification_answer: input.clarificationAnswer || null,
  };
  return Object.freeze({ contact_id: input.contactId, idempotency_key: requestKey,
    ...sceneSnapshot(input.scene),
    ...(input.mode !== 'rewrite_draft' && input.skillChoice?.mode === 'disabled' ? { skill_disabled: true } : {}),
    ...(input.mode !== 'rewrite_draft' && input.skillChoice?.mode === 'user' ? { skill_version_id: input.skillChoice.versionId } : {}),
    content: Object.freeze(content),
    ...(expected === undefined ? {} : { expected_input_version_id: expected.toLowerCase() }),
    ...(adopted === undefined ? {} : { adopt_new_message_id: adopted.toLowerCase() }) });
}

// 比较权威保存的原采用声明；字段及值必须全等，JSON对象的键顺序不代表来历。
export function matchesReplyAdoption(input: unknown, submission: unknown): boolean {
  if (!isRecord(input) || !isRecord(input.continuation) || !isRecord(submission) || !isRecord(submission.content)) return false;
  const value = input.continuation.message_adoption;
  if (!isRecord(value) || !Object.hasOwn(value, 'content') || !isRecord(value.content)) return false;
  const { content, ...expected } = submission, { content: actualContent, ...actual } = value;
  const sameFields = (left: Record<string, unknown>, right: object) => Object.keys(left).length === Object.keys(right).length
    && Object.entries(right).every(([key, field]) => Object.hasOwn(left, key) && left[key] === field);
  return sameFields(actual, expected) && sameFields(actualContent, content);
}

// 输入仍经现有生成应用边界；返回前须已可靠保存到所属助手会话。
export async function generateReply(backend: BackendHost, input: ReplyInputSnapshot, requestKey: string,
  signal: AbortSignal, sessionId?: string, onPrepared?: (receipt: AssistantGenerationReceipt) => void | Promise<void>,
  onRequested?: () => void, expectedInputVersionId?: string, onPrepareRequest?: () => void, onNoGeneration?: (proof: AssistantNoGenerationProof) => void, options?: ReplyRequestOptions) {
  const selected = sessionId ?? (await defaultAssistantSession(backend, input.contactId, signal)).sessionId;
  const generation = backend.getConnectionGeneration();
  if (expectedInputVersionId !== undefined && options?.expectedInputVersionId !== undefined
    && expectedInputVersionId.toLowerCase() !== options.expectedInputVersionId.toLowerCase()) throw new Error('本次重试输入已变化。');
  const body = replyRequestBody(input, requestKey, { ...options,
    expectedInputVersionId: options?.expectedInputVersionId ?? expectedInputVersionId });
  const preparing = backend.requestJson({ method: 'POST',
    path: `/api/contacts/${input.contactId}/assistant-sessions/${selected}/replies/prepare`, body, signal, acceptAssistantNoGenerationProof: true });
  onPrepareRequest?.();
  const prepared = await ownedPreparation(backend, preparing, { generation, contactId: input.contactId, sessionId: selected,
    requestKey }, onNoGeneration);
  if (prepared.generation !== generation || backend.getConnectionGeneration() !== generation) throw new Error('本次生成连接已变化。');
  const receipt = readAssistantGenerationReceipt(prepared.data, selected, requestKey);
  await onPrepared?.(receipt);
  return completePreparedReply(backend, input.contactId, body, selected, receipt, signal, onRequested);
}

export async function replaceReply(backend: BackendHost, input: ReplyInputSnapshot, newRequestKey: string,
  runningRequestKey: string, signal: AbortSignal, sessionId: string,
  onPrepared?: (receipt: AssistantGenerationReceipt) => void | Promise<void>, onRequested?: () => void, onPrepareRequest?: () => void,
  onNoGeneration?: (proof: AssistantNoGenerationProof) => void, options?: ReplyRequestOptions) {
  if (!isUuid(runningRequestKey) || runningRequestKey === newRequestKey) throw new Error('本次替换请求归属无效。');
  const generation = backend.getConnectionGeneration();
  const body = replyRequestBody(input, newRequestKey, options);
  const preparing = backend.requestJson({ method: 'POST',
    path: `/api/contacts/${input.contactId}/assistant-sessions/${sessionId}/replace/prepare`,
    body: Object.freeze({ running_request_key: runningRequestKey, replacement: body }), signal, acceptAssistantNoGenerationProof: true });
  onPrepareRequest?.();
  const prepared = await ownedPreparation(backend, preparing, { generation, contactId: input.contactId, sessionId,
    requestKey: newRequestKey }, onNoGeneration);
  if (prepared.generation !== generation || backend.getConnectionGeneration() !== generation) throw new Error('本次生成连接已变化。');
  const receipt = readAssistantGenerationReceipt(prepared.data, sessionId, newRequestKey);
  await onPrepared?.(receipt);
  return completePreparedReply(backend, input.contactId, body, sessionId, receipt, signal, onRequested);
}

export interface InterruptedReplyOrigin { readonly turnId: string; readonly inputVersionId: string; }

// 恢复只提交严格原身份和新key；原正文、编号版本及策略仍由同一后端authority提供。
export async function retryInterruptedReply(backend: BackendHost, contactId: string, sessionId: string,
  origin: InterruptedReplyOrigin, requestKey: string, signal: AbortSignal,
  onPrepared?: (receipt: AssistantGenerationReceipt) => void | Promise<void>, onRequested?: () => void,
  onPrepareRequest?: () => void, onNoGeneration?: (proof: AssistantNoGenerationProof) => void) {
  if (![contactId, sessionId, origin.turnId, origin.inputVersionId, requestKey].every(isUuid)) {
    throw new Error('中断恢复身份无效。');
  }
  const generation = backend.getConnectionGeneration();
  const body = Object.freeze({ original_turn_id: origin.turnId, original_input_version_id: origin.inputVersionId, request_key: requestKey });
  const path = `/api/contacts/${contactId}/assistant-sessions/${sessionId}/retry-interrupted`;
  const preparing = backend.requestJson({ method: 'POST', path: path + '/prepare', body, signal, acceptAssistantNoGenerationProof: true });
  onPrepareRequest?.();
  const prepared = await ownedPreparation(backend, preparing, { generation, contactId, sessionId, requestKey }, onNoGeneration);
  if (prepared.generation !== generation || backend.getConnectionGeneration() !== generation) throw new Error('本次生成连接已变化。');
  const receipt = readAssistantGenerationReceipt(prepared.data, sessionId, requestKey);
  await onPrepared?.(receipt);
  if (signal.aborted) throw new BackendRequestFailure('cancelled');
  const executing = backend.requestJson({ method: 'POST', path, body, signal, timeoutMs: 25_000 });
  onRequested?.();
  const response = await executing;
  const result = readPreparedReply(response, sessionId, receipt);
  const value = response.data;
  const restored = isRecord(value) ? value.restored_input : undefined;
  const continuation = isRecord(restored) ? restored.continuation : undefined;
  const recovery = isRecord(continuation) ? continuation.recovery : undefined;
  if (!isRecord(restored) || !isRecord(restored.content) || !isRecord(recovery)
    || Object.keys(recovery).length !== 2 || recovery.original_turn_id !== body.original_turn_id
    || recovery.original_input_version_id !== body.original_input_version_id) throw new Error('原中断输入尚未可靠恢复。');
  return { ...result, restoredInput: restored as NonNullable<SavedAssistantTurn['input']> };
}

async function completePreparedReply(backend: BackendHost, contactId: string, body: ReturnType<typeof replyRequestBody>,
  selected: string, receipt: AssistantGenerationReceipt, signal: AbortSignal, onRequested?: () => void) {
  if (signal.aborted) throw new BackendRequestFailure('cancelled');
  const requested = backend.requestJson({
    method: 'POST', path: `/api/contacts/${contactId}/assistant-sessions/${selected}/replies`, timeoutMs: 25_000, signal,
    body,
  });
  onRequested?.();
  const result = readPreparedReply(await requested, selected, receipt);
  return body.adopt_new_message_id === undefined ? result : { ...result, adoptionSubmission: body };
}

function readPreparedReply(response: Awaited<ReturnType<BackendHost['requestJson']>>, selected: string,
  receipt: AssistantGenerationReceipt) {
  const value = response.data;
  if (!isRecord(value) || value.session_id !== selected || !isUuid(value.input_version_id)
    || value.input_version_id !== receipt.inputVersionId || value.turn_id !== receipt.turnId
    || value.state !== 'completed') throw new Error('本次结果尚未可靠保存，请重试同一次生成。');
  return { ...readReplyResult(value), generation: response.generation, assistantSessionId: selected,
    inputVersionId: value.input_version_id.toLowerCase() };
}

async function ownedPreparation(backend: BackendHost, preparing: ReturnType<BackendHost['requestJson']>,
  expected: { generation: number | undefined; contactId: string; sessionId: string; requestKey: string },
  onNoGeneration?: (proof: AssistantNoGenerationProof) => void) {
  try { return await preparing; }
  catch (error) {
    if (error instanceof BackendRequestFailure && error.noGeneration && expected.generation !== undefined
      && backend.getConnectionGeneration() === expected.generation && error.noGeneration.contactId === expected.contactId
      && error.noGeneration.sessionId === expected.sessionId && error.noGeneration.requestKey === expected.requestKey) {
      onNoGeneration?.(error.noGeneration);
    }
    throw error;
  }
}
