import type { MemoryProcessing, MemoryProcessingRequest, MemoryProcessingResumeRequest, MemoryProcessingTask, MemoryProcessingHistoryRequest, MemoryProcessingHistory, MemoryProcessingCurrent, MemoryProcessingUnit } from '../../shared/memory-processing';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { isUuid } from '../uuid';

export function processingArguments(args: unknown[]): MemoryProcessingRequest {
  const value = args[0] as Record<string, unknown> | undefined;
  if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('记忆进度范围不可用。');
  if (value.scope === 'owner' && Object.keys(value).length === 1) return { scope: 'owner' };
  if (value.scope === 'contact' && Object.keys(value).length === 3 && isUuid(value.contactId)
    && Number.isSafeInteger(value.scopeRevision) && (value.scopeRevision as number) >= 0) {
    return { scope: 'contact', contactId: value.contactId.toLowerCase(), scopeRevision: value.scopeRevision as number };
  }
  throw new Error('记忆进度范围不可用。');
}

export function processingResumeArguments(args: unknown[]): MemoryProcessingResumeRequest {
  const fields = args[0] as Record<string, unknown> | undefined;
  if (args.length !== 1 || !fields || typeof fields !== 'object' || Array.isArray(fields)
    || !isUuid(fields.taskId) || !['resume', 'restart'].includes(fields.action as string)) throw new Error('记忆任务操作不可用。');
  const { taskId, action, ...scope } = fields;
  return { ...processingArguments([scope]), taskId: (taskId as string).toLowerCase(), action: action as 'resume' | 'restart' };
}

const invalid = () => new Error('记忆处理响应不可用。');
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function count(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid();
  return value as number;
}
function nullableId(value: unknown): string | null {
  if (value === null) return null;
  if (!isUuid(value)) throw invalid();
  return value.toLowerCase();
}
function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw invalid();
  return value;
}
function unit(value: unknown): MemoryProcessingUnit | null {
  if (value !== null && !['messages', 'memories', 'steps'].includes(value as string)) throw invalid();
  return value as MemoryProcessingUnit | null;
}
function scope(data: unknown, request: MemoryProcessingRequest): Record<string, unknown> {
  if (!record(data) || data.scope !== request.scope || data.contact_id !== (request.scope === 'owner' ? null : request.contactId)) throw invalid();
  return data;
}
function entries(data: unknown, request: MemoryProcessingRequest): MemoryProcessingTask[] {
  if (!Array.isArray(data)) throw invalid();
  const seen = new Set<string>();
  return data.map(raw => {
    if (!record(raw) || !isUuid(raw.task_id) || seen.has(raw.task_id) || raw.contact_id !== (request.scope === 'owner' ? null : request.contactId)
      || !['import', 'observation', 'layered_memory'].includes(raw.task_type as string)
      || !['queued', 'running', 'verifying', 'succeeded', 'failed', 'cancelled', 'paused', 'interrupted'].includes(raw.status as string)
      || typeof raw.phase !== 'string' || typeof raw.updated_at !== 'string' || !Number.isFinite(Date.parse(raw.updated_at))
      || !['verified', 'legacy'].includes(raw.attribution as string)) throw invalid();
    seen.add(raw.task_id);
    const processedCount = count(raw.processed_count), totalCount = count(raw.total_count);
    if (processedCount !== null && totalCount !== null && processedCount > totalCount) throw invalid();
    return { taskId: raw.task_id, roundId: nullableId(raw.round_id), contactId: nullableId(raw.contact_id),
      taskType: raw.task_type as MemoryProcessingTask['taskType'], status: raw.status as string, phase: raw.phase,
      processedCount, totalCount, unit: unit(raw.unit), updatedAt: raw.updated_at,
      reasonCode: nullableText(raw.reason_code), attribution: raw.attribution as MemoryProcessingTask['attribution'] };
  });
}
function cursor(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw invalid();
  return value;
}
function current(data: unknown): MemoryProcessingCurrent {
  if (!record(data) || !['waiting', 'processing', 'completed', 'paused', 'blocked'].includes(data.status as string)
    || (data.phase !== null && !['extraction', 'verification', 'topics', 'profile', 'retry'].includes(data.phase as string))
    || typeof data.has_usable_results !== 'boolean' || !Array.isArray(data.actions) || data.actions.length !== 0) throw invalid();
  const processedCount = count(data.processed_count), totalCount = count(data.total_count), quantityUnit = unit(data.unit);
  if ((processedCount !== null && totalCount !== null && processedCount > totalCount)
    || ((processedCount !== null || totalCount !== null) && quantityUnit === null)) throw invalid();
  return { status: data.status as MemoryProcessingCurrent['status'], roundId: nullableId(data.round_id),
    phase: data.phase as MemoryProcessingCurrent['phase'], processedCount, totalCount, unit: quantityUnit,
    pendingCount: count(data.pending_count), reason: nullableText(data.reason), reasonCode: nullableText(data.reason_code),
    hasUsableResults: data.has_usable_results, actions: [] };
}
function processing(data: unknown, request: MemoryProcessingRequest): MemoryProcessing {
  const value = scope(data, request), generation = count(value.control_generation);
  if (generation === null || !record(value.history)) throw invalid();
  return { scope: request.scope, contactId: request.scope === 'owner' ? null : request.contactId,
    controlGeneration: generation, current: current(value.current),
    history: { entries: entries(value.history.entries, request), nextCursor: cursor(value.history.next_cursor),
      ...(value.history.error === undefined ? {} : { error: nullableText(value.history.error) ?? undefined }) } };
}
export function processingHistoryArguments(args: unknown[]): MemoryProcessingHistoryRequest {
  const value = args[0];
  if (args.length !== 1 || !record(value) || (value.cursor !== null && typeof value.cursor !== 'string')) throw invalid();
  const { cursor: pageCursor, ...request } = value;
  cursor(pageCursor);
  return { ...processingArguments([request]), cursor: pageCursor as string | null };
}

// 读取与历史分页分别撤销；联系人选择和后台连接代次变化立即使晚结果失效。
export class MemoryProcessingController {
  private reads = new Map<string, AbortController>();
  constructor(private backend: BackendHost, private contacts: ContactSession) {}
  private key(request: MemoryProcessingRequest) { return request.scope === 'owner' ? 'owner' : `${request.contactId}:${request.scopeRevision}`; }
  private current(request: MemoryProcessingRequest, generation: number | undefined) {
    const selection = this.contacts.getState();
    return generation !== undefined && this.backend.getConnectionGeneration() === generation
      && (request.scope === 'owner' || (selection.selectedContactId === request.contactId && selection.scopeRevision === request.scopeRevision));
  }
  synchronize(contactOnly = false) {
    for (const [key, operation] of this.reads) if (!contactOnly || !key.startsWith('owner:')) { operation.abort(); this.reads.delete(key); }
  }
  cancel(request: MemoryProcessingRequest) {
    for (const kind of ['state', 'history']) {
      const key = `${this.key(request)}:${kind}`;
      this.reads.get(key)?.abort(); this.reads.delete(key);
    }
  }
  async resume(_request: MemoryProcessingResumeRequest): Promise<void> {
    throw new Error('统一记忆处理操作尚不可用，请先核对处理详情。');
  }
  private async get(request: MemoryProcessingRequest, kind: 'state' | 'history', query = ''): Promise<unknown> {
    const generation = this.backend.getConnectionGeneration();
    if (!this.current(request, generation)) throw new Error('记忆处理范围已变化。');
    const key = `${this.key(request)}:${kind}`;
    this.reads.get(key)?.abort();
    const operation = new AbortController(); this.reads.set(key, operation);
    try {
      const root = request.scope === 'owner' ? '/api/owner/memory-processing' : `/api/contacts/${request.contactId}/memory-processing`;
      const result = await this.backend.requestJson({ method: 'GET', path: `${root}/${kind}${query}`, signal: operation.signal });
      if (operation.signal.aborted || this.reads.get(key) !== operation || result.generation !== generation || !this.current(request, generation)) throw new Error('记忆处理范围已变化。');
      return result.data;
    } finally { if (this.reads.get(key) === operation) this.reads.delete(key); }
  }
  async read(request: MemoryProcessingRequest): Promise<MemoryProcessing> {
    return processing(await this.get(request, 'state'), request);
  }
  async history(request: MemoryProcessingHistoryRequest): Promise<MemoryProcessingHistory> {
    const value = scope(await this.get(request, 'history', request.cursor === null ? '' : `?cursor=${encodeURIComponent(request.cursor)}`), request);
    return { scope: request.scope, contactId: request.scope === 'owner' ? null : request.contactId,
      entries: entries(value.entries, request), nextCursor: cursor(value.next_cursor) };
  }
}
