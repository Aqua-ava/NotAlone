import type { SavedAssistantTurn } from '../../shared/assistant-session';
import type { BackendHost } from '../backend/host';
import { isUuid } from '../uuid';
import { isRecord, readReplyResult } from './result-read';

export async function defaultAssistantSession(backend: BackendHost, contactId: string, signal: AbortSignal) {
  const response = await backend.requestJson({ method: 'POST',
    path: `/api/contacts/${contactId}/assistant-session/default`, body: {}, signal });
  if (!isRecord(response.data) || !isUuid(response.data.session_id)) throw new Error('助手会话暂不可用。');
  return { sessionId: response.data.session_id.toLowerCase(), generation: response.generation };
}

export async function readAssistantSession(backend: BackendHost, contactId: string, sessionId: string, signal: AbortSignal) {
  const response = await backend.requestJson({ method: 'GET',
    path: `/api/contacts/${contactId}/assistant-sessions/${sessionId}`, signal });
  const value = response.data;
  if (!isRecord(value) || value.session_id !== sessionId || !Array.isArray(value.turns)) throw new Error('已保存讨论暂不可用。');
  const known = new Set<string>();
  const turns: SavedAssistantTurn[] = value.turns.map((item: unknown) => {
    if (!isRecord(item) || !isUuid(item.turn_id) || !isUuid(item.input_version_id) || !isUuid(item.request_key)
      || !['running', 'completed', 'failed', 'redacted', 'unavailable'].includes(item.state as string)
      || (item.input !== null && (!isRecord(item.input) || !isRecord(item.input.content)))
      || (item.placeholder !== null && !['相关来源已删除', '相关来源不可用'].includes(item.placeholder as string))) throw new Error('已保存讨论格式无效。');
    const turnId = item.turn_id.toLowerCase();
    if (known.has(turnId) || (['redacted', 'unavailable'].includes(item.state as string)
      && (item.input !== null || item.reply !== null))) throw new Error('已保存讨论格式无效。');
    known.add(turnId);
    return { turnId, inputVersionId: item.input_version_id.toLowerCase(), requestKey: item.request_key.toLowerCase(),
      state: item.state as SavedAssistantTurn['state'], input: item.input as SavedAssistantTurn['input'],
      reply: item.reply === null ? null : readReplyResult(item.reply), placeholder: item.placeholder as string | null };
  });
  return { sessionId, turns, generation: response.generation };
}
