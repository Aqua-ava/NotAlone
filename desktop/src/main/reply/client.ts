import type { ReplyInputSnapshot } from '../../shared/reply-bridge';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import { isUuid } from '../uuid';
import { defaultAssistantSession } from './assistant-sessions';
import { isRecord, readReplyResult } from './result-read';
import { readAssistantGenerationReceipt, type AssistantGenerationReceipt } from './assistant-generation-jobs';

// prepare 与实际生成共用同一规范正文，不能在两段调用之间从当前界面重新取输入。
export function replyRequestBody(input: ReplyInputSnapshot, requestKey: string) {
  return { contact_id: input.contactId, idempotency_key: requestKey,
    ...(input.mode !== 'rewrite_draft' && input.skillChoice?.mode === 'disabled' ? { skill_disabled: true } : {}),
    ...(input.mode !== 'rewrite_draft' && input.skillChoice?.mode === 'user' ? { skill_version_id: input.skillChoice.versionId } : {}),
    content: input.mode === 'rewrite_draft' ? {
      type: 'rewrite_draft', draft_text: input.draftText, user_instruction: input.userInstruction,
      include_relationship_context: input.includeRelationshipContext,
    } : input.mode === 'initiate_conversation' ? {
      type: 'initiate_conversation', purpose: input.purpose, understanding_correction: input.correction || null,
      user_instruction: input.userInstruction || null, clarification_answer: input.clarificationAnswer || null,
    } : {
      type: 'reply_to_message', target_message_id: input.target.messageId, direction: input.direction, direction_source: 'direct_input',
      understanding_correction: input.correction || null, user_instruction: input.userInstruction || null,
      clarification_answer: input.clarificationAnswer || null,
    } };
}

// 输入仍经现有生成应用边界；返回前须已可靠保存到所属助手会话。
export async function generateReply(backend: BackendHost, input: ReplyInputSnapshot, requestKey: string,
  signal: AbortSignal, sessionId?: string, onPrepared?: (receipt: AssistantGenerationReceipt) => void,
  onRequested?: () => void) {
  const selected = sessionId ?? (await defaultAssistantSession(backend, input.contactId, signal)).sessionId;
  const generation = backend.getConnectionGeneration();
  const body = replyRequestBody(input, requestKey);
  const prepared = await backend.requestJson({ method: 'POST',
    path: `/api/contacts/${input.contactId}/assistant-sessions/${selected}/replies/prepare`, body, signal });
  if (prepared.generation !== generation || backend.getConnectionGeneration() !== generation) throw new Error('本次生成连接已变化。');
  const receipt = readAssistantGenerationReceipt(prepared.data, selected, requestKey);
  onPrepared?.(receipt);
  return completePreparedReply(backend, input.contactId, body, selected, receipt, signal, onRequested);
}

export async function replaceReply(backend: BackendHost, input: ReplyInputSnapshot, newRequestKey: string,
  runningRequestKey: string, signal: AbortSignal, sessionId: string,
  onPrepared?: (receipt: AssistantGenerationReceipt) => void, onRequested?: () => void) {
  if (!isUuid(runningRequestKey) || runningRequestKey === newRequestKey) throw new Error('本次替换请求归属无效。');
  const generation = backend.getConnectionGeneration();
  const body = replyRequestBody(input, newRequestKey);
  const prepared = await backend.requestJson({ method: 'POST',
    path: `/api/contacts/${input.contactId}/assistant-sessions/${sessionId}/replace/prepare`,
    body: { running_request_key: runningRequestKey, replacement: body }, signal });
  if (prepared.generation !== generation || backend.getConnectionGeneration() !== generation) throw new Error('本次生成连接已变化。');
  const receipt = readAssistantGenerationReceipt(prepared.data, sessionId, newRequestKey);
  onPrepared?.(receipt);
  return completePreparedReply(backend, input.contactId, body, sessionId, receipt, signal, onRequested);
}

async function completePreparedReply(backend: BackendHost, contactId: string, body: ReturnType<typeof replyRequestBody>,
  selected: string, receipt: AssistantGenerationReceipt, signal: AbortSignal, onRequested?: () => void) {
  if (signal.aborted) throw new BackendRequestFailure('cancelled');
  const requested = backend.requestJson({
    method: 'POST', path: `/api/contacts/${contactId}/assistant-sessions/${selected}/replies`, timeoutMs: 25_000, signal,
    body,
  });
  onRequested?.();
  const response = await requested;
  const value = response.data;
  if (!isRecord(value) || value.session_id !== selected || !isUuid(value.input_version_id)
    || value.input_version_id !== receipt.inputVersionId || value.turn_id !== receipt.turnId
    || value.state !== 'completed') throw new Error('本次结果尚未可靠保存，请重试同一次生成。');
  return { ...readReplyResult(value), generation: response.generation, assistantSessionId: selected,
    inputVersionId: value.input_version_id.toLowerCase() };
}
