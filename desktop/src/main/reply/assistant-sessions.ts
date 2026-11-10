import {readSqliteDiscussion} from './sqlite-discussion-read';
import type { SavedAssistantDiscussion, SavedAssistantInput, SavedAssistantTurn, SavedAssistantSession } from '../../shared/assistant-session';
import { readAssistantCarry } from './assistant-candidate-carry';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import { isUuid } from '../uuid';
import { isRecord, readReplyResult } from './result-read';
import { readReplyBasisChanges } from './basis-changes-read';
import { readReplyScene } from './scene';
import { listAssistantSessions } from './assistant-session-catalog';

// 单次请求承载完整会话视图；上限对齐 json-client 运输层的响应字节门禁。
const FULL_READ_BYTES = 8_388_608;
const invalidRead = () => new Error('已保存讨论暂不可用。');

function discussion(value: unknown, type: SavedAssistantDiscussion['type']): SavedAssistantDiscussion {
  const fields = ['type', 'correction', 'requirements', 'answer', 'confirmed_intent', 'skill_mode', 'skill_version_id',
    type === 'purpose_exploration' ? 'purpose_hint' : 'target_message_id',
    ...(isRecord(value) && Object.hasOwn(value, 'skill_scene') ? ['skill_scene'] : [])];
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
    skillVersionId: typeof value.skill_version_id === 'string' ? value.skill_version_id.toLowerCase() : null,
    ...(Object.hasOwn(value, 'skill_scene') ? { skillScene: readReplyScene(value.skill_scene) } : {}) };
  if (type === 'purpose_exploration' && typeof value.purpose_hint === 'string') return { ...common, type, purposeHint: value.purpose_hint };
  if (type === 'response_exploration' && isUuid(value.target_message_id)) return { ...common, type, targetMessageId: value.target_message_id.toLowerCase() };
  throw new Error('已保存讨论格式无效。');
}

async function pendingAssistantDeletion(backend: BackendHost, contactId: string, signal: AbortSignal) {
  const generation = backend.getConnectionGeneration();
  const pending = await backend.requestJson({ method: 'GET', path: `/api/deletions?contact_id=${contactId}&scope_kind=discussion`, signal });
  if (generation === undefined || pending.generation !== generation || backend.getConnectionGeneration() !== generation
    || !isRecord(pending.data) || !Array.isArray(pending.data.operations)) throw new Error('助手会话删除状态暂不可用。');
  for (const operation of pending.data.operations) {
    if (!isRecord(operation) || operation.scope_kind !== 'discussion' || operation.contact_id !== contactId
      || !isUuid(operation.target_id) || !isUuid(operation.operation_id)
      || !['queued', 'running', 'verifying', 'failed'].includes(operation.status as string)) throw new Error('助手会话删除状态无效。');
  }
  const deletion = pending.data.operations[0];
  if (deletion) return { sessionId: deletion.target_id.toLowerCase(), generation,
    deletionOperationId: deletion.operation_id as string };
  return undefined;
}

export async function currentAssistantSession(backend: BackendHost, contactId: string, signal: AbortSignal) {
  const deletion = await pendingAssistantDeletion(backend, contactId, signal);
  if (deletion) return { ...deletion, catalog: undefined };
  const catalog = await listAssistantSessions(backend, contactId, signal);
  return { sessionId: catalog.currentSessionId, generation: catalog.generation, deletionOperationId: undefined, catalog };
}

export async function defaultAssistantSession(backend: BackendHost, contactId: string, signal: AbortSignal) {
  const deletion = await pendingAssistantDeletion(backend, contactId, signal);
  if (deletion) return deletion;
  const response = await backend.requestJson({ method: 'POST',
    path: `/api/contacts/${contactId}/assistant-session/default`, body: {}, signal });
  if (!isRecord(response.data) || !isUuid(response.data.session_id)) throw new Error('助手会话暂不可用。');
  return { sessionId: response.data.session_id.toLowerCase(), generation: response.generation };
}

export async function readAssistantSession(backend: Pick<BackendHost, 'getConnectionGeneration' | 'requestJson'>, contactId: string, sessionId: string, signal: AbortSignal): Promise<Omit<SavedAssistantSession,'phase'|'sessionId'> & {sessionId:string;generation:number}> {
  const path = `/api/contacts/${contactId}/assistant-sessions/${sessionId}`;
  const generation = backend.getConnectionGeneration?.();
  const current = () => !signal.aborted && (typeof backend.getConnectionGeneration !== 'function'
    || generation !== undefined && generation === backend.getConnectionGeneration());
  if (!current()) throw new BackendRequestFailure('cancelled');
  let response;
  try {
    response = await backend.requestJson({ method: 'GET', path, signal, maxResponseBytes: FULL_READ_BYTES });
  } catch (error) {
    // 请求失败但连接已换代或已取消时按取消报告，不把传输细节当作读取结论。
    if (!current()) throw new BackendRequestFailure('cancelled');
    throw error;
  }
  if (!current() || generation !== undefined && response.generation !== generation) throw new BackendRequestFailure('cancelled');
  const value = response.data;
  if (isRecord(value) && value.mode === 'sqlite') return readSqliteDiscussion(value,sessionId,response.generation);
  if (!isRecord(value) || value.session_id !== sessionId || !Array.isArray(value.turns) || !Array.isArray(value.inputs)
    || (value.current_input_version_id !== null && !isUuid(value.current_input_version_id))) throw new Error('已保存讨论暂不可用。');
  const known = new Set<string>();
  const turns: SavedAssistantTurn[] = value.turns.map((item: unknown) => {
    if (!isRecord(item) || !isUuid(item.turn_id) || !isUuid(item.input_version_id) || !isUuid(item.request_key)
      || !['running', 'completed', 'failed', 'redacted', 'unavailable'].includes(item.state as string)
      || !(item.interruption_reason === null || item.state === 'failed' && ['app_quit', 'configuration_reload', 'user_cancelled'].includes(item.interruption_reason as string))
      || (item.generation_active !== undefined && typeof item.generation_active !== 'boolean')
      || (item.requires_reprepare !== undefined && typeof item.requires_reprepare !== 'boolean')
      || (item.input !== null && (!isRecord(item.input) || !isRecord(item.input.content)))
      || (item.placeholder !== null && !['相关来源已删除', '相关来源不可用'].includes(item.placeholder as string))) throw new Error('已保存讨论格式无效。');
    const turnId = item.turn_id.toLowerCase();
    if (known.has(turnId) || (['redacted', 'unavailable'].includes(item.state as string)
      && (item.input !== null || item.reply !== null))) throw new Error('已保存讨论格式无效。');
    known.add(turnId);
    if (item.input !== null) readReplyScene(item.input.scene);
    const basisChanges = readReplyBasisChanges(item.basis_changes);
    if (['redacted', 'unavailable'].includes(item.state as string) && basisChanges.length) throw invalidRead();
    return { turnId, inputVersionId: item.input_version_id.toLowerCase(), requestKey: item.request_key.toLowerCase(),
      state: item.state as SavedAssistantTurn['state'], input: item.input as SavedAssistantTurn['input'],
      reply: item.reply === null ? null : readReplyResult(item.reply), interruptionReason: item.interruption_reason as SavedAssistantTurn['interruptionReason'], placeholder: item.placeholder as string | null,
      ...(item.basis_changes === undefined ? {} : { basisChanges }),
      ...(typeof item.generation_active === 'boolean' ? { generationActive: item.generation_active } : {}),
      ...(item.requires_reprepare === true ? { requiresReprepare: true } : {}) };
  });
  const versions = new Set<string>();
  const inputs: SavedAssistantInput[] = value.inputs.map((item: unknown) => {
    if (!isRecord(item) || Object.keys(item).length !== (Object.hasOwn(item, 'basis_changes') ? 8 : 7) || !Object.keys(item).every((key) => [
      'input_version_id', 'type', 'conversation_binding_id', 'turn_id', 'state', 'content', 'placeholder', 'basis_changes',
    ].includes(key)) || !isUuid(item.input_version_id) || !isUuid(item.conversation_binding_id)
      || !['generation', 'purpose_exploration', 'response_exploration', 'candidate_carry'].includes(item.type as string)
      || !['active', 'redacted', 'unavailable'].includes(item.state as string)) throw new Error('已保存讨论格式无效。');
    const version = item.input_version_id.toLowerCase();
    const expectedPlaceholder = item.state === 'redacted' ? '相关来源已删除' : item.state === 'unavailable' ? '相关来源不可用' : null;
    if (versions.has(version) || item.placeholder !== expectedPlaceholder
      || (item.state !== 'active' && item.content !== null)) throw new Error('已保存讨论格式无效。');
    versions.add(version);
    const basisChanges = readReplyBasisChanges(item.basis_changes);
    if (item.state !== 'active' && basisChanges.length) throw invalidRead();
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
      state: item.state as SavedAssistantInput['state'], content, placeholder: expectedPlaceholder,
      ...(item.basis_changes === undefined ? {} : { basisChanges }) };
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
  const response = await backend.requestJson({ method: 'DELETE', path, body: { confirmed: true }, signal });
  const receipt = response.data;
  if (response.generation !== generation || !isRecord(receipt) || !isUuid(receipt.operation_id)) {
    throw new Error('助手会话删除尚未取得可核验的操作凭证。');
  }
  const operation = await backend.requestJson({ method: 'GET', path: `/api/deletions/${receipt.operation_id}`, signal });
  if (backend.getConnectionGeneration() !== generation || operation.generation !== generation
    || !isRecord(operation.data) || operation.data.operation_id !== receipt.operation_id
    || operation.data.scope_kind !== 'discussion' || operation.data.status !== 'succeeded') {
    throw new Error('助手会话清理尚未完成，请重试删除。');
  }
  try {
    await backend.requestJson({ method: 'GET', path, signal });
  } catch (error) {
    if (backend.getConnectionGeneration() === generation && error instanceof BackendRequestFailure
      && error.status === 404 && error.code === 'not_found') return { phase: 'deleted', generation };
    throw error;
  }
  throw new Error('助手会话仍可读取，删除尚未完成。');
}
