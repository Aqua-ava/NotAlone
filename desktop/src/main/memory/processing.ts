import type { MemoryProcessing, MemoryProcessingRequest, MemoryProcessingResumeRequest, MemoryProcessingTask } from '../../shared/memory-processing';
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

function processing(data: unknown, request: MemoryProcessingRequest): MemoryProcessing {
  const value = data as Record<string, unknown> | null;
  const contactId = request.scope === 'contact' ? request.contactId : null;
  if (!value || value.scope !== request.scope || value.contact_id !== contactId || typeof value.has_more !== 'boolean' || !Array.isArray(value.tasks)) throw new Error('记忆进度响应不可用。');
  const count = (value: unknown): number | null => {
    if (value === null) return null;
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('记忆进度统计不可用。');
    return value as number;
  };
  const seen = new Set<string>();
  const tasks = value.tasks.map((raw: unknown): MemoryProcessingTask => {
    const entry = raw as Record<string, unknown> | null;
    if (!entry || !isUuid(entry.task_id) || seen.has(entry.task_id) || !isUuid(entry.contact_id)
      || (contactId !== null && entry.contact_id !== contactId) || !['import', 'observation'].includes(entry.task_type as string)
      || !['queued', 'extracting', 'organizing', 'completed', 'interrupted', 'failed', 'stopped'].includes(entry.status as string)
      || typeof entry.phase !== 'string' || typeof entry.updated_at !== 'string' || !Number.isFinite(Date.parse(entry.updated_at))
      || (entry.reason_code !== null && typeof entry.reason_code !== 'string')
      || ![null, 'resume', 'restart'].includes(entry.action as string | null)
      || (entry.action === 'resume' && !['interrupted', 'failed'].includes(entry.status as string))
      || (entry.action === 'restart' && entry.status !== 'stopped')) throw new Error('记忆任务状态不可用。');
    seen.add(entry.task_id);
    const processedCount = count(entry.processed_count), totalCount = count(entry.total_count);
    if (processedCount !== null && totalCount !== null && processedCount > totalCount) throw new Error('记忆进度统计不可用。');
    return { taskId: entry.task_id, contactId: entry.contact_id, taskType: entry.task_type as MemoryProcessingTask['taskType'],
      status: entry.status as MemoryProcessingTask['status'], phase: entry.phase,
      processedCount, totalCount, createdCount: count(entry.created_count), updatedCount: count(entry.updated_count),
      updatedAt: entry.updated_at, reasonCode: entry.reason_code as string | null, action: entry.action as MemoryProcessingTask['action'] };
  });
  return { scope: request.scope, contactId, tasks, hasMore: value.has_more as boolean };
}

// 页面只读轮询；离开页面或切换联系人立即撤销当前读取，不扫描或启动任务。
export class MemoryProcessingController {
  private reads = new Map<string, AbortController>();
  private snapshots = new Map<string, { generation: number; value: MemoryProcessing }>();
  private writes = new Map<string, { action: string; promise: Promise<void> }>();
  constructor(private backend: BackendHost, private contacts: ContactSession) {}
  private key(request: MemoryProcessingRequest) { return request.scope === 'owner' ? 'owner' : `${request.contactId}:${request.scopeRevision}`; }
  private current(request: MemoryProcessingRequest, generation: number | undefined) {
    const selection = this.contacts.getState();
    return generation !== undefined && this.backend.getConnectionGeneration() === generation
      && (request.scope === 'owner' || (selection.selectedContactId === request.contactId && selection.scopeRevision === request.scopeRevision));
  }
  synchronize(contactOnly = false) {
    for (const [key, operation] of this.reads) if (!contactOnly || key !== 'owner') { operation.abort(); this.reads.delete(key); }
    for (const key of this.snapshots.keys()) if (!contactOnly || key !== 'owner') this.snapshots.delete(key);
  }
  cancel(request: MemoryProcessingRequest) { const key = this.key(request); this.reads.get(key)?.abort(); this.reads.delete(key); }
  async resume(request: MemoryProcessingResumeRequest): Promise<void> {
    const generation = this.backend.getConnectionGeneration(), key = this.key(request);
    if (!this.current(request, generation)) throw new Error('记忆任务范围已变化。');
    const snapshot = this.snapshots.get(key);
    const task = snapshot && snapshot.generation === generation ? snapshot.value.tasks.find(task => task.taskId === request.taskId) : undefined;
    if (!task || task.action !== request.action) throw new Error('任务状态已变化，请刷新后重试。');
    const writeKey = `${generation}:${request.taskId}`, pending = this.writes.get(writeKey);
    if (pending) {
      if (pending.action !== request.action) throw new Error('记忆任务正在处理。');
      return pending.promise;
    }
    const promise = (async () => {
      const path = request.scope === 'owner' ? '/api/owner/memory-processing/resume' : `/api/contacts/${request.contactId}/memory-processing/resume`;
      const result = await this.backend.requestJson({ method: 'POST', path, body: { task_id: request.taskId, action: request.action } });
      const data = result.data as Record<string, unknown> | null;
      if (!this.current(request, generation) || result.generation !== generation || !data || data.task_id !== request.taskId
        || !['queued', 'running', 'busy', 'completed'].includes(data.status as string)) throw new Error('操作结果未确认，请刷新任务状态。');
      this.snapshots.delete(key);
    })();
    this.writes.set(writeKey, { action: request.action, promise });
    try { await promise; } finally { this.writes.delete(writeKey); }
  }
  async read(request: MemoryProcessingRequest): Promise<MemoryProcessing> {
    const generation = this.backend.getConnectionGeneration();
    if (generation === undefined || !this.current(request, generation)) throw new Error('记忆进度范围已变化。');
    this.cancel(request);
    const key = this.key(request), operation = new AbortController(); this.reads.set(key, operation);
    try {
      const path = request.scope === 'owner' ? '/api/owner/memory-processing' : `/api/contacts/${request.contactId}/memory-processing`;
      const result = await this.backend.requestJson({ method: 'GET', path, signal: operation.signal });
      if (operation.signal.aborted || this.reads.get(key) !== operation || result.generation !== generation || !this.current(request, generation)) throw new Error('记忆进度范围已变化。');
      const value = processing(result.data, request);
      this.snapshots.set(key, { generation, value });
      return value;
    } catch (error) {
      if (this.reads.get(key) === operation) this.snapshots.delete(key);
      throw error;
    } finally { if (this.reads.get(key) === operation) this.reads.delete(key); }
  }
}
