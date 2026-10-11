import type { AssistantSessionCatalog } from '../../shared/assistant-session';
import type { BackendHost } from '../backend/host';
import { isUuid } from '../uuid';
import { isRecord } from './result-read';

export async function listAssistantSessions(backend: BackendHost, contactId: string, signal: AbortSignal) {
  const response = await backend.requestJson({ method: 'GET',
    path: `/api/contacts/${contactId}/assistant-sessions`, signal });
  const value = response.data;
  if (!isRecord(value) || Object.keys(value).length !== 2 || !Array.isArray(value.sessions)
    || (value.current_session_id !== null && !isUuid(value.current_session_id))) throw new Error('助手会话目录暂不可用。');
  const known = new Set<string>();
  const items: AssistantSessionCatalog['items'] = value.sessions.map((item: unknown) => {
    if (!isRecord(item) || Object.keys(item).length !== 2 || !isUuid(item.session_id)
      || typeof item.is_current !== 'boolean') throw new Error('助手会话目录格式无效。');
    const sessionId = item.session_id.toLowerCase();
    if (known.has(sessionId)) throw new Error('助手会话目录格式无效。');
    known.add(sessionId);
    return { sessionId, isCurrent: item.is_current };
  });
  const currentSessionId = typeof value.current_session_id === 'string' ? value.current_session_id.toLowerCase() : null;
  const current = items.filter((item) => item.isCurrent);
  if (current.length > 1 || (current[0]?.sessionId ?? null) !== currentSessionId) throw new Error('助手会话目录格式无效。');
  return { items, currentSessionId, generation: response.generation };
}

export async function newAssistantSession(backend: BackendHost, contactId: string, signal: AbortSignal) {
  const response = await backend.requestJson({ method: 'POST',
    path: `/api/contacts/${contactId}/assistant-sessions`, body: {}, signal });
  if (!isRecord(response.data) || Object.keys(response.data).length !== 1 || !isUuid(response.data.session_id)) {
    throw new Error('新开助手会话尚未确认。');
  }
  return { sessionId: response.data.session_id.toLowerCase(), generation: response.generation };
}

export async function selectAssistantSession(backend: BackendHost, contactId: string, sessionId: string, signal: AbortSignal) {
  const response = await backend.requestJson({ method: 'POST',
    path: `/api/contacts/${contactId}/assistant-sessions/${sessionId}/select`, body: {}, signal });
  if (!isRecord(response.data) || Object.keys(response.data).length !== 1 || response.data.session_id !== sessionId) {
    throw new Error('选择助手会话尚未确认。');
  }
  return { sessionId, generation: response.generation };
}
