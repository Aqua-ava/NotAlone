import { createHash } from 'node:crypto';
import type { SavedAssistantDiscussion, SavedAssistantInput, SavedAssistantTurn } from '../../shared/assistant-session';
import { readAssistantCarry } from './assistant-candidate-carry';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import { isUuid } from '../uuid';
import { isRecord, readReplyResult } from './result-read';

const READ_PART_BYTES = 256 * 1024;
const invalidRead = () => new Error('已保存讨论暂不可用。');

async function readAssistantSessionParts(backend: Pick<BackendHost, 'getConnectionGeneration' | 'requestJson'>, path: string, sessionId: string,
  signal: AbortSignal, generation: number, current: () => boolean) {
  const fragments: string[] = [];
  let first: Record<string, unknown> | undefined;
  let partNumber = 0, byteCount = 0;
  const fields = ['session_id', 'current_input_version_id', 'read_id', 'part_number', 'part_count',
    'payload_bytes', 'payload_fragment', 'next_part'];
  const sameHeader = (part: Record<string, unknown>) => !first || ['session_id', 'current_input_version_id',
    'read_id', 'part_count', 'payload_bytes'].every((key) => part[key] === first![key]);
  while (current()) {
    const anchor = first ? `&read_id=${first.read_id}` : '';
    const response = await backend.requestJson({ method: 'GET', path: `${path}?read_part=${partNumber}${anchor}`, signal });
    if (!current() || response.generation !== generation) throw new BackendRequestFailure('cancelled');
    const part = response.data;
    if (!isRecord(part) || Object.keys(part).length !== fields.length || Object.keys(part).some((key) => !fields.includes(key))
      || part.session_id !== sessionId || (part.current_input_version_id !== null && !isUuid(part.current_input_version_id))
      || typeof part.read_id !== 'string' || !/^[0-9a-f]{64}$/.test(part.read_id)
      || part.part_number !== partNumber || !Number.isSafeInteger(part.part_count) || (part.part_count as number) < 1
      || partNumber >= (part.part_count as number) || !Number.isSafeInteger(part.payload_bytes) || (part.payload_bytes as number) < 1
      || typeof part.payload_fragment !== 'string' || !part.payload_fragment || !sameHeader(part)
      || part.next_part !== (partNumber + 1 < (part.part_count as number) ? partNumber + 1 : null)) throw invalidRead();
    const fragment = Buffer.from(part.payload_fragment, 'utf8');
    if (fragment.length > READ_PART_BYTES || fragment.toString('utf8') !== part.payload_fragment
      || (part.next_part !== null && fragment.length < READ_PART_BYTES - 3)) throw invalidRead();
    byteCount += fragment.length;
    if (!Number.isSafeInteger(byteCount) || byteCount > (part.payload_bytes as number)) throw invalidRead();
    first ??= part;
    fragments.push(part.payload_fragment);
    if (part.next_part === null) {
      const wire = fragments.join('');
      if (byteCount !== part.payload_bytes || createHash('sha256').update(wire, 'utf8').digest('hex') !== part.read_id) throw invalidRead();
      const verified = await backend.requestJson({ method: 'GET', path: `${path}?read_part=0&read_id=${part.read_id}`, signal });
      if (!current() || verified.generation !== generation) throw new BackendRequestFailure('cancelled');
      const receipt = verified.data;
      // 最后正文收齐后再核验同一权威读取；任意失败只丢弃本次内存累积。
      if (!isRecord(receipt) || Object.keys(receipt).length !== fields.length || Object.keys(receipt).some((key) => !fields.includes(key))
        || !sameHeader(receipt) || receipt.part_number !== 0 || receipt.payload_fragment !== first.payload_fragment
        || receipt.next_part !== first.next_part) throw invalidRead();
      const value: unknown = JSON.parse(wire);
      if (!isRecord(value) || value.session_id !== sessionId
        || value.current_input_version_id !== first.current_input_version_id) throw invalidRead();
      return { data: value, generation };
    }
    partNumber += 1;
  }
  throw new BackendRequestFailure('cancelled');
}

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

export async function readAssistantSession(backend: Pick<BackendHost, 'getConnectionGeneration' | 'requestJson'>, contactId: string, sessionId: string, signal: AbortSignal) {
  const path = `/api/contacts/${contactId}/assistant-sessions/${sessionId}`;
  const generation = backend.getConnectionGeneration?.();
  const current = () => !signal.aborted && (typeof backend.getConnectionGeneration !== 'function'
    || generation !== undefined && generation === backend.getConnectionGeneration());
  if (!current()) throw new BackendRequestFailure('cancelled');
  let response;
  try {
    response = await backend.requestJson({ method: 'GET', path, signal });
  } catch (error) {
    if (!current()) throw new BackendRequestFailure('cancelled');
    if (!(error instanceof BackendRequestFailure) || error.kind !== 'response' || error.status !== undefined
      || error.code !== 'response_too_large'
      || generation === undefined) throw error;
    response = await readAssistantSessionParts(backend, path, sessionId, signal, generation, current);
  }
  if (!current() || generation !== undefined && response.generation !== generation) throw new BackendRequestFailure('cancelled');
  const value = response.data;
  if (!isRecord(value) || value.session_id !== sessionId || !Array.isArray(value.turns) || !Array.isArray(value.inputs)
    || (value.current_input_version_id !== null && !isUuid(value.current_input_version_id))) throw new Error('已保存讨论暂不可用。');
  const known = new Set<string>();
  const turns: SavedAssistantTurn[] = value.turns.map((item: unknown) => {
    if (!isRecord(item) || !isUuid(item.turn_id) || !isUuid(item.input_version_id) || !isUuid(item.request_key)
      || !['running', 'completed', 'failed', 'redacted', 'unavailable'].includes(item.state as string)
      || !(item.interruption_reason === null || item.state === 'failed' && item.interruption_reason === 'app_quit')
      || (item.generation_active !== undefined && typeof item.generation_active !== 'boolean')
      || (item.input !== null && (!isRecord(item.input) || !isRecord(item.input.content)))
      || (item.placeholder !== null && !['相关来源已删除', '相关来源不可用'].includes(item.placeholder as string))) throw new Error('已保存讨论格式无效。');
    const turnId = item.turn_id.toLowerCase();
    if (known.has(turnId) || (['redacted', 'unavailable'].includes(item.state as string)
      && (item.input !== null || item.reply !== null))) throw new Error('已保存讨论格式无效。');
    known.add(turnId);
    return { turnId, inputVersionId: item.input_version_id.toLowerCase(), requestKey: item.request_key.toLowerCase(),
      state: item.state as SavedAssistantTurn['state'], input: item.input as SavedAssistantTurn['input'],
      reply: item.reply === null ? null : readReplyResult(item.reply), interruptionReason: item.interruption_reason as 'app_quit' | null, placeholder: item.placeholder as string | null,
      ...(typeof item.generation_active === 'boolean' ? { generationActive: item.generation_active } : {}) };
  });
  const versions = new Set<string>();
  const inputs: SavedAssistantInput[] = value.inputs.map((item: unknown) => {
    if (!isRecord(item) || Object.keys(item).length !== 7 || !Object.keys(item).every((key) => [
      'input_version_id', 'type', 'conversation_binding_id', 'turn_id', 'state', 'content', 'placeholder',
    ].includes(key)) || !isUuid(item.input_version_id) || !isUuid(item.conversation_binding_id)
      || !['generation', 'purpose_exploration', 'response_exploration', 'candidate_carry'].includes(item.type as string)
      || !['active', 'redacted', 'unavailable'].includes(item.state as string)) throw new Error('已保存讨论格式无效。');
    const version = item.input_version_id.toLowerCase();
    const expectedPlaceholder = item.state === 'redacted' ? '相关来源已删除' : item.state === 'unavailable' ? '相关来源不可用' : null;
    if (versions.has(version) || item.placeholder !== expectedPlaceholder
      || (item.state !== 'active' && item.content !== null)) throw new Error('已保存讨论格式无效。');
    versions.add(version);
    let content: SavedAssistantInput['content'] = null;
    if (item.type === 'generation') {
      const turnId = isUuid(item.turn_id) ? item.turn_id.toLowerCase() : null;
      const turn = turns.find((candidate) => candidate.turnId === turnId);
      if (!turn || turn.inputVersionId !== version || item.content !== null
        || (['redacted', 'unavailable'].includes(turn.state) ? turn.state !== item.state : item.state !== 'active')) {
        throw new Error('已保存讨论格式无效。');
      }
    } else {
      if (item.turn_id !== null) throw new Error('已保存讨论格式无效。');
      if (item.state === 'active') content = item.type === 'candidate_carry'
        ? readAssistantCarry(item.content, contactId, sessionId, item.conversation_binding_id.toLowerCase())
        : discussion(item.content, item.type as SavedAssistantDiscussion['type']);
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
