import type { ReplyInputSnapshot } from '../../shared/reply-bridge';
import type { BackendHost } from '../backend/host';
import { isUuid } from '../uuid';
import { defaultAssistantSession } from './assistant-sessions';
import { isRecord, readReplyResult } from './result-read';

// 输入仍经现有生成应用边界；返回前须已可靠保存到所属助手会话。
export async function generateReply(backend: BackendHost, input: ReplyInputSnapshot, requestKey: string,
  signal: AbortSignal, sessionId?: string) {
  const selected = sessionId ?? (await defaultAssistantSession(backend, input.contactId, signal)).sessionId;
  const response = await backend.requestJson({
    method: 'POST', path: `/api/contacts/${input.contactId}/assistant-sessions/${selected}/replies`, timeoutMs: 25_000, signal,
    body: { contact_id: input.contactId, idempotency_key: requestKey,
      ...(input.mode !== 'rewrite_draft' && input.skillChoice?.mode === 'disabled' ? { skill_disabled: true } : {}),
      ...(input.mode !== 'rewrite_draft' && input.skillChoice?.mode === 'user' ? { skill_version_id: input.skillChoice.versionId } : {}),
      content: input.mode === 'rewrite_draft' ? {
      type: 'rewrite_draft', draft_text: input.draftText,
      user_instruction: input.userInstruction, include_relationship_context: input.includeRelationshipContext,
    } : input.mode === 'initiate_conversation' ? {
      type: 'initiate_conversation', purpose: input.purpose, understanding_correction: input.correction || null,
      user_instruction: input.userInstruction || null, clarification_answer: input.clarificationAnswer || null,
    } : {
      type: 'reply_to_message', target_message_id: input.target.messageId,
      direction: input.direction, direction_source: 'direct_input',
      understanding_correction: input.correction || null, user_instruction: input.userInstruction || null, clarification_answer: input.clarificationAnswer || null,
    } },
  });
  const value = response.data;
  if (!isRecord(value) || value.session_id !== selected || !isUuid(value.input_version_id)
    || value.state !== 'completed') throw new Error('本次结果尚未可靠保存，请重试同一次生成。');
  return { ...readReplyResult(value), generation: response.generation, assistantSessionId: selected,
    inputVersionId: value.input_version_id.toLowerCase() };
}
