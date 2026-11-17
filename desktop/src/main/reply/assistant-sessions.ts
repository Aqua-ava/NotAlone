import {readSqliteDiscussion} from './sqlite-discussion-read';
import type { SavedAssistantSession } from '../../shared/assistant-session';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import { isUuid } from '../uuid';
import { isRecord } from '../is-record';
import { listAssistantSessions } from './assistant-session-catalog';

// 单次请求承载完整会话视图；上限对齐 json-client 运输层的响应字节门禁。
const FULL_READ_BYTES = 8_388_608;
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

export async function readAssistantSession(backend: Pick<BackendHost, 'getConnectionGeneration' | 'requestJson'>, contactId: string, sessionId: string, signal: AbortSignal): Promise<Omit<SavedAssistantSession,'phase'|'sessionId'> & {sessionId:string;generation:number}> {
  const path = `/api/contacts/${contactId}/assistant-sessions/${sessionId}`;
  const generation = backend.getConnectionGeneration();
  const current = () => !signal.aborted && generation !== undefined && generation === backend.getConnectionGeneration();
  if (!current()) throw new BackendRequestFailure('cancelled');
  let response;
  try {
    response = await backend.requestJson({ method: 'GET', path, signal, maxResponseBytes: FULL_READ_BYTES });
  } catch (error) {
    // 请求失败但连接已换代或已取消时按取消报告，不把传输细节当作读取结论。
    if (!current()) throw new BackendRequestFailure('cancelled');
    throw error;
  }
  if (!current() || response.generation !== generation) throw new BackendRequestFailure('cancelled');
  return readSqliteDiscussion(response.data, sessionId, response.generation);
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
