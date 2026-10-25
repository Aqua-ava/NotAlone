import type {
  BackgroundTask,
  BackgroundTaskAction,
  BackgroundTaskSelection,
  BackgroundTaskState,
  BackgroundTaskStep,
} from '../../shared/background-task-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { isUuid } from '../uuid';

const taskTypes = ['import', 'observation', 'delete', 'skill_learning', 'layered_memory', 'memory_upgrade'] as const;
const taskStatuses = ['queued', 'running', 'verifying', 'succeeded', 'failed', 'cancelled', 'paused', 'interrupted'] as const;
const active = new Set(['queued', 'running', 'verifying']);
const invalid = () => new Error('后台任务响应不可用。');
const record = (value: unknown): value is Record<string, unknown> => Boolean(value)
  && typeof value === 'object' && !Array.isArray(value);

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid();
  return value as number;
}
function identifier(value: unknown): string {
  if (!isUuid(value)) throw invalid();
  return value.toLowerCase();
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw invalid();
  return value;
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw invalid();
  return value;
}
function action(value: unknown): BackgroundTaskAction {
  if (!record(value) || typeof value.kind !== 'string') throw invalid();
  if (value.kind === 'stop' && Object.keys(value).length === 1) return { kind: 'stop' };
  if (value.kind !== 'recover') throw invalid();
  if ((value.target === 'tasks' || value.target === 'skill_learning') && Object.keys(value).length === 2) {
    return { kind: 'recover', target: value.target };
  }
  if (value.target === 'layered_memory' && Object.keys(value).length === 4) {
    const workRevision = integer(value.work_revision), settingsGeneration = integer(value.settings_generation);
    if (workRevision < 1) throw invalid();
    return { kind: 'recover', target: 'layered_memory', workRevision, settingsGeneration };
  }
  throw invalid();
}
function step(value: unknown): BackgroundTaskStep {
  if (!record(value) || !['name', 'status', 'attempt_count', 'processed_count', 'total_count',
    'error_code', 'lease_expires_at'].every(key => Object.hasOwn(value, key))
    || Object.keys(value).length !== 7) throw invalid();
  if (value.error_code !== null && typeof value.error_code !== 'string') throw invalid();
  if (value.lease_expires_at !== null) date(value.lease_expires_at);
  return {
    name: text(value.name), status: text(value.status), attemptCount: integer(value.attempt_count),
    processedCount: integer(value.processed_count),
    totalCount: value.total_count === null ? null : integer(value.total_count),
    errorCode: value.error_code as string | null,
    leaseExpiresAt: value.lease_expires_at as string | null,
  };
}
function task(value: unknown, selection: BackgroundTaskSelection): BackgroundTask {
  if (!record(value) || ![
    'actions', 'contact_id', 'error_code', 'message_count', 'phase', 'processed_count', 'retry_count',
    'scope_kind', 'settings_generation', 'status', 'steps', 'task_id', 'task_type', 'total_count',
    'updated_at', 'work_revision',
  ].every(key => Object.hasOwn(value, key)) || Object.keys(value).length !== 16) throw invalid();
  if ((selection.scope === 'contact'
    ? identifier(value.contact_id) !== selection.contactId || value.scope_kind !== 'contact'
    : value.contact_id !== null || value.scope_kind !== 'owner')
    || !taskTypes.includes(value.task_type as BackgroundTask['taskType'])
    || !taskStatuses.includes(value.status as BackgroundTask['status'])
    || !Array.isArray(value.steps) || !Array.isArray(value.actions)
    || value.error_code !== null && typeof value.error_code !== 'string'
    || value.work_revision !== null && integer(value.work_revision) < 1
    || value.settings_generation !== null && integer(value.settings_generation) < 0) throw invalid();
  const processedCount = integer(value.processed_count);
  const totalCount = value.total_count === null ? null : integer(value.total_count);
  if (totalCount !== null && processedCount > totalCount) throw invalid();
  return {
    taskId: identifier(value.task_id), taskType: value.task_type as BackgroundTask['taskType'],
    status: value.status as BackgroundTask['status'], phase: text(value.phase),
    messageCount: integer(value.message_count), retryCount: integer(value.retry_count),
    errorCode: value.error_code as string | null, processedCount, totalCount,
    updatedAt: date(value.updated_at), steps: value.steps.map(step), actions: value.actions.map(action),
  };
}

export function backgroundTaskSelection(value: unknown): BackgroundTaskSelection {
  if (!record(value) || !Number.isSafeInteger(value.scopeRevision) || (value.scopeRevision as number) < 0) {
    throw new Error('后台任务范围不可用。');
  }
  if (value.scope === 'owner' && Object.keys(value).length === 2) {
    return { scope: 'owner', scopeRevision: value.scopeRevision as number };
  }
  if (value.scope === 'contact' && Object.keys(value).length === 3 && isUuid(value.contactId)) {
    return { scope: 'contact', contactId: value.contactId.toLowerCase(), scopeRevision: value.scopeRevision as number };
  }
  throw new Error('后台任务范围不可用。');
}

export class BackgroundTaskController {
  private state: BackgroundTaskState = {
    phase: 'idle', scope: null, contactId: null, scopeRevision: 0, tasks: [], hasMore: false,
    error: null, busyTaskId: null, message: null,
  };
  private readOperation: AbortController | undefined;
  private writeOperation: AbortController | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private snapshotGeneration: number | undefined;
  private readonly listeners = new Set<(state: BackgroundTaskState) => void>();

  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession) {}

  getState(): BackgroundTaskState { return structuredClone(this.state); }
  onStateChanged(listener: (state: BackgroundTaskState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  synchronizeScope(): void {
    this.clearPoll();
    this.readOperation?.abort();
    this.readOperation = undefined;
    const selected = this.contacts.getState();
    const disconnected = this.snapshotGeneration !== undefined
      && this.snapshotGeneration !== this.backend.getConnectionGeneration();
    const changed = this.state.scope !== null && (this.state.scopeRevision !== selected.scopeRevision
      || this.state.scope === 'contact' && this.state.contactId !== selected.selectedContactId);
    if (disconnected || changed) {
      this.state = { phase: 'idle', scope: null, contactId: null, scopeRevision: 0, tasks: [],
        hasMore: false, error: null, busyTaskId: null, message: null };
      this.snapshotGeneration = undefined;
      this.publish({});
    }
  }

  cancelRead(): void {
    this.clearPoll();
    this.readOperation?.abort();
    this.readOperation = undefined;
  }

  async read(selection: BackgroundTaskSelection, background = false): Promise<void> {
    this.assertCurrent(selection);
    this.cancelRead();
    const generation = this.backend.getConnectionGeneration();
    const operation = new AbortController();
    this.readOperation = operation;
    if (!background) {
      this.publish({ phase: 'loading', scope: selection.scope,
        contactId: selection.scope === 'contact' ? selection.contactId : null,
        scopeRevision: selection.scopeRevision, tasks: [], error: null, message: null });
    }
    try {
      const path = selection.scope === 'contact'
        ? `/api/tasks?contact_id=${encodeURIComponent(selection.contactId)}&limit=100`
        : '/api/tasks?scope=owner&limit=100';
      const result = await this.backend.requestJson({
        method: 'GET', path,
        signal: operation.signal, maxResponseBytes: 262_144,
      });
      if (!this.current(selection, generation) || operation.signal.aborted
        || this.readOperation !== operation || result.generation !== generation) return;
      const data = result.data;
      if (!record(data) || !Array.isArray(data.tasks) || typeof data.has_more !== 'boolean') throw invalid();
      const seen = new Set<string>();
      const tasks = data.tasks.map(value => {
        const item = task(value, selection);
        if (seen.has(item.taskId)) throw invalid();
        seen.add(item.taskId);
        return item;
      });
      this.publish({ phase: 'ready', tasks, hasMore: data.has_more, error: null });
      this.snapshotGeneration = generation;
      if (tasks.some(item => active.has(item.status))) {
        this.pollTimer = setTimeout(() => {
          this.pollTimer = undefined;
          if (this.current(selection, generation)) void this.read(selection, true).catch(() => {});
        }, 1500);
        this.pollTimer.unref();
      }
    } catch {
      if (this.current(selection, generation) && this.readOperation === operation) {
        this.publish(background
          ? { error: '后台任务刷新失败，保留上次已核验状态。' }
          : { phase: 'error', tasks: [], hasMore: false, error: '后台任务暂时无法读取。' });
      }
    } finally {
      if (this.readOperation === operation) this.readOperation = undefined;
    }
  }

  async stop(selection: BackgroundTaskSelection & { taskId: string }): Promise<void> {
    await this.mutate(selection, 'stop');
  }

  async recover(selection: BackgroundTaskSelection & { taskId: string }): Promise<void> {
    await this.mutate(selection, 'recover');
  }

  private async mutate(selection: BackgroundTaskSelection & { taskId: string }, action: 'stop' | 'recover'): Promise<void> {
    this.assertCurrent(selection);
    if (!isUuid(selection.taskId) || this.state.phase !== 'ready' || this.state.busyTaskId) {
      throw new Error('后台任务状态已变化，请刷新后重试。');
    }
    const task = this.state.tasks.find(item => item.taskId === selection.taskId);
    const choice = action === 'stop'
      ? task?.actions.find(item => item.kind === 'stop')
      : task?.actions.find(item => item.kind === 'recover');
    if (!task || !choice) throw new Error('该任务当前不允许此操作。');
    const generation = this.backend.getConnectionGeneration();
    const operation = new AbortController();
    this.writeOperation?.abort();
    this.writeOperation = operation;
    this.publish({ busyTaskId: task.taskId, message: action === 'stop' ? '正在停止原任务…' : '正在恢复原任务…' });
    let path: string, body: Record<string, unknown>;
    const contact = selection.scope === 'contact' ? { contact_id: selection.contactId } : {};
    const scope = selection.scope === 'owner' ? { scope: 'owner' as const } : {};
    if (choice.kind === 'stop') {
      path = '/api/tasks/stop';
      body = { ...contact, ...scope, task_id: task.taskId };
    } else if (choice.target === 'tasks') {
      path = '/api/tasks/recover';
      body = { ...contact, ...scope, task_id: task.taskId,
        action: task.status === 'cancelled' ? 'restart' : 'resume' };
    } else if (choice.target === 'skill_learning') {
      if (selection.scope !== 'contact') throw new Error('后台任务恢复入口不可用。');
      path = `/api/contacts/${selection.contactId}/skill-learning`;
      body = { resume: true };
    } else if (choice.target === 'layered_memory') {
      path = selection.scope === 'contact'
        ? `/api/contacts/${selection.contactId}/layered-memory/continue`
        : '/api/memories/owner/layered-memory/continue';
      body = { work_revision: choice.workRevision, settings_generation: choice.settingsGeneration };
    } else {
      throw new Error('后台任务恢复入口不可用。');
    }
    try {
      const result = await this.backend.requestJson({ method: 'POST', path, body,
        signal: operation.signal, maxResponseBytes: 262_144 });
      if (!this.current(selection, generation) || operation.signal.aborted
        || this.writeOperation !== operation || result.generation !== generation) return;
      this.publish({ busyTaskId: null, message: action === 'stop' ? '停止请求已提交。' : '恢复请求已提交，正在重读持久状态。' });
      await this.read(selection);
    } catch (error) {
      if (this.current(selection, generation)) {
        this.publish({ busyTaskId: null, error: action === 'stop'
          ? '停止结果尚未确认，请刷新任务状态。'
          : '恢复结果尚未确认，请刷新任务状态。' });
      }
      throw error;
    } finally {
      if (this.writeOperation === operation) this.writeOperation = undefined;
    }
  }

  private assertCurrent(selection: BackgroundTaskSelection): void {
    if (!this.current(selection, this.backend.getConnectionGeneration())
      || this.state.phase === 'ready' && this.snapshotGeneration !== this.backend.getConnectionGeneration()) {
      throw new Error('后台任务范围已变化。');
    }
  }
  private current(selection: BackgroundTaskSelection, generation: number | undefined): boolean {
    const selected = this.contacts.getState();
    return generation !== undefined && this.backend.getConnectionGeneration() === generation
      && selected.scopeRevision === selection.scopeRevision
      && (selection.scope === 'owner' || selected.selectedContactId === selection.contactId);
  }
  private clearPoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }
  private publish(update: Partial<BackgroundTaskState>): void {
    this.state = { ...this.state, ...update };
    const value = this.getState();
    for (const listener of this.listeners) listener(value);
  }
}
