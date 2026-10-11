import type { SavedAssistantDiscussion, SavedAssistantInput, SavedAssistantTurn } from '../../shared/assistant-session';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import { isUuid } from '../uuid';
import { isRecord, readReplyResult } from './result-read';

function discussion(value: unknown, type: SavedAssistantDiscussion['type']): SavedAssistantDiscussion {
  const fields = ['type', 'correction', 'requirements', 'answer', 'confirmed_intent', 'skill_mode', 'skill_version_id',
    type === 'purpose_exploration' ? 'purpose_hint' : 'target_message_id'];
  if (!isRecord(value) || value.type !== type || Object.keys(value).length !== fields.length
    || !Object.keys(value).every((key) => fields.includes(key))
    || !['correction', 'requirements', 'answer', 'confirmed_intent'].every((key) => typeof value[key] === 'string')
    || !['auto', 'disabled', 'user'].includes(value.skill_mode as string)
    || (value.skill_mode === 'user' ? !isUuid(value.skill_version_id) : value.skill_version_id !== null)) {
    throw new Error('已保存讨论格式无效。');
  }
  const common = { correction: value.correction as string, requirements: value.requirements as string,
    answer: value.answer as string, confirmedIntent: value.confirmed_intent as string,
    skillMode: value.skill_mode as SavedAssistantDiscussion['skillMode'],
    skillVersionId: typeof value.skill_version_id === 'string' ? value.skill_version_id.toLowerCase() : null };
  if (type === 'purpose_exploration' && typeof value.purpose_hint === 'string') return { ...common, type, purposeHint: value.purpose_hint };
  if (type === 'response_exploration' && isUuid(value.target_message_id)) return { ...common, type, targetMessageId: value.target_message_id.toLowerCase() };
  throw new Error('已保存讨论格式无效。');
}

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
  if (!isRecord(value) || value.session_id !== sessionId || !Array.isArray(value.turns) || !Array.isArray(value.inputs)
    || (value.current_input_version_id !== null && !isUuid(value.current_input_version_id))) throw new Error('已保存讨论暂不可用。');
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
  const versions = new Set<string>();
  const inputs: SavedAssistantInput[] = value.inputs.map((item: unknown) => {
    if (!isRecord(item) || Object.keys(item).length !== 7 || !Object.keys(item).every((key) => [
      'input_version_id', 'type', 'conversation_binding_id', 'turn_id', 'state', 'content', 'placeholder',
    ].includes(key)) || !isUuid(item.input_version_id) || !isUuid(item.conversation_binding_id)
      || !['generation', 'purpose_exploration', 'response_exploration'].includes(item.type as string)
      || !['active', 'redacted', 'unavailable'].includes(item.state as string)) throw new Error('已保存讨论格式无效。');
    const version = item.input_version_id.toLowerCase();
    const expectedPlaceholder = item.state === 'redacted' ? '相关来源已删除' : item.state === 'unavailable' ? '相关来源不可用' : null;
    if (versions.has(version) || item.placeholder !== expectedPlaceholder
      || (item.state !== 'active' && item.content !== null)) throw new Error('已保存讨论格式无效。');
    versions.add(version);
    let content: SavedAssistantDiscussion | null = null;
    if (item.type === 'generation') {
      const turnId = isUuid(item.turn_id) ? item.turn_id.toLowerCase() : null;
      const turn = turns.find((candidate) => candidate.turnId === turnId);
      if (!turn || turn.inputVersionId !== version || item.content !== null
        || (['redacted', 'unavailable'].includes(turn.state) ? turn.state !== item.state : item.state !== 'active')) {
        throw new Error('已保存讨论格式无效。');
      }
    } else {
      if (item.turn_id !== null) throw new Error('已保存讨论格式无效。');
      if (item.state === 'active') content = discussion(item.content, item.type as SavedAssistantDiscussion['type']);
    }
    return { inputVersionId: version, type: item.type as SavedAssistantInput['type'],
      conversationBindingId: item.conversation_binding_id.toLowerCase(),
      turnId: typeof item.turn_id === 'string' ? item.turn_id.toLowerCase() : null,
      state: item.state as SavedAssistantInput['state'], content, placeholder: expectedPlaceholder };
  });
  if (turns.some((turn) => !inputs.some((input) => input.type === 'generation' && input.turnId === turn.turnId))
    || (typeof value.current_input_version_id === 'string' && !versions.has(value.current_input_version_id.toLowerCase()))) {
    throw new Error('已保存讨论格式无效。');
  }
  return { sessionId, turns, inputs, currentInputVersionId: typeof value.current_input_version_id === 'string'
    ? value.current_input_version_id.toLowerCase() : null, generation: response.generation };
}

export async function deleteAssistantSession(backend: BackendHost, contactId: string, sessionId: string,
  signal: AbortSignal): Promise<{ phase: 'deleted' | 'missing'; generation: number }> {
  const path = `/api/contacts/${contactId}/assistant-sessions/${sessionId}`;
  const generation = backend.getConnectionGeneration();
  if (generation === undefined) throw new Error('助手会话删除尚未确认。');
  let acknowledged = false;
  try {
    const response = await backend.requestJson({ method: 'DELETE', path, body: { confirmed: true }, signal });
    acknowledged = response.generation === generation && isRecord(response.data)
      && response.data.session_id === sessionId && response.data.state === 'deleted';
  } catch (error) {
    if (signal.aborted || (error instanceof BackendRequestFailure && error.kind === 'cancelled')) throw error;
    // 丢包或已不存在时仍核对同一已知会话；不能借新默认会话宣称删除完成。
  }
  try {
    await backend.requestJson({ method: 'GET', path, signal });
  } catch (error) {
    if (error instanceof BackendRequestFailure && error.status === 404 && error.code === 'not_found') {
      return { phase: acknowledged ? 'deleted' : 'missing', generation };
    }
    throw error;
  }
  throw new Error('助手会话仍可读取，删除尚未完成。');
}
