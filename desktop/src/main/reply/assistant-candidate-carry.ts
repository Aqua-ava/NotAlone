import type { AssistantCandidateCarry } from '../../shared/reply-bridge';
import type { SavedAssistantCarry } from '../../shared/assistant-session';
import type { BackendHost } from '../backend/host';
import { isUuid } from '../uuid';
import { isRecord } from './result-read';

export async function newAssistantSessionWithCandidate(backend: BackendHost, command: AssistantCandidateCarry,
  signal: AbortSignal) {
  const response = await backend.requestJson({ method: 'POST',
    path: `/api/contacts/${command.contactId}/assistant-sessions/${command.sessionId}/new-with-candidate`,
    body: { expected_selection_id: command.expectedSelectionId, candidate_id: command.candidateId,
      version_id: command.versionId }, signal });
  const value = response.data;
  if (!isRecord(value) || Object.keys(value).length !== 2 || !isUuid(value.session_id)
    || !isUuid(value.input_version_id) || value.session_id === command.sessionId) throw new Error('携入会话尚未确认。');
  return { sessionId: value.session_id.toLowerCase(), inputVersionId: value.input_version_id.toLowerCase(),
    generation: response.generation };
}

// 正文只消费后端逐次复验的公开投影，不建立来历或正文缓存。
export function readAssistantCarry(value: unknown, contactId: string, sessionId: string,
  bindingId: string): SavedAssistantCarry {
  const ids = ['origin_owner_id', 'origin_contact_id', 'origin_binding_id', 'origin_session_id',
    'origin_input_version_id', 'origin_turn_id', 'origin_reply_request_id', 'origin_candidate_id',
    'origin_version_id', 'origin_selection_id'];
  const fields = ['type', 'metadata_version', ...ids, 'payload_sha256', 'messages'];
  if (!isRecord(value) || Object.keys(value).length !== fields.length
    || Object.keys(value).some((key) => !fields.includes(key)) || value.type !== 'candidate_carry'
    || value.metadata_version !== 2 || ids.some((key) => !isUuid(value[key]))
    || value.origin_contact_id !== contactId || value.origin_binding_id !== bindingId
    || value.origin_session_id === sessionId || typeof value.payload_sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.payload_sha256)
    || !Array.isArray(value.messages) || !value.messages.length) throw new Error('携入版本暂不可用。');
  const messages = value.messages.map((message: unknown) => {
    if (!isRecord(message) || Object.keys(message).length !== 2 || !isUuid(message.message_id)
      || typeof message.text !== 'string' || !message.text.trim()) throw new Error('携入版本暂不可用。');
    return { messageId: message.message_id.toLowerCase(), text: message.text };
  });
  if (new Set(messages.map((message) => message.messageId)).size !== messages.length) throw new Error('携入版本暂不可用。');
  return { type: 'candidate_carry', originSessionId: (value.origin_session_id as string).toLowerCase(),
    originCandidateId: (value.origin_candidate_id as string).toLowerCase(),
    originVersionId: (value.origin_version_id as string).toLowerCase(),
    originSelectionId: (value.origin_selection_id as string).toLowerCase(), messages };
}
