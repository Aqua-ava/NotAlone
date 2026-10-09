import type { SourceDeletionRequest, SourceDeletionState } from '../../shared/source-deletion-bridge';
import type { ContactSelection } from '../../shared/contact-session-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { deletionSources, deletionTask } from './read';
import { SourceDeletionTracking } from './tracking';
type Scope = { generation: number; contactId: string; scopeRevision: number };

// DELETE只表示请求被接受；每次公开重读原任务及固定最终步骤，绝不推断SSE或百分比完成。
export class SourceDeletionController {
  private state: SourceDeletionState = { revision: 0, contactId: null, scopeRevision: 0, phase: 'idle', sources: [], busySourceId: null, error: null };
  private scope: Scope | undefined;
  private revision = 0;
  private pending: AbortController | undefined;
  private poll: NodeJS.Timeout | undefined;
  private pollCount = 0;
  private readonly tracking: SourceDeletionTracking;
  private readonly verified = new Set<string>();
  private readonly listeners = new Set<(state: SourceDeletionState) => void>();
  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession,
    private readonly onSourceChanged: (contactId: string) => Promise<void>) {
    this.tracking = new SourceDeletionTracking(backend, onSourceChanged);
    contacts.onStateChanged(() => this.synchronizeScope());
    backend.onStateChanged(() => this.synchronizeScope());
    this.synchronizeScope();
  }
  getState() { return structuredClone(this.state); }
  onStateChanged(listener: (state: SourceDeletionState) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private synchronizeScope() {
    const generation = this.backend.getConnectionGeneration();
    const contacts = this.contacts.getState();
    const contactId = contacts.selectedContactId;
    const allowed = generation !== undefined && contactId !== null
      && ['ready', 'loading'].includes(contacts.directoryPhase) && contacts.contacts.some((entry) => entry.contactId === contactId);
    const next = allowed ? { generation, contactId: contactId!, scopeRevision: contacts.scopeRevision } : undefined;
    if (next?.generation === this.scope?.generation && next?.contactId === this.scope?.contactId && next?.scopeRevision === this.scope?.scopeRevision) return;
    this.cancel(); this.scope = next; this.verified.clear(); this.pollCount = 0;
    this.publish({ contactId: next?.contactId ?? null, scopeRevision: contacts.scopeRevision, phase: 'idle', sources: [], busySourceId: null, error: null });
  }
  private assertScope(request: ContactSelection): Scope {
    this.synchronizeScope();
    if (!this.scope || request.contactId !== this.scope.contactId || request.scopeRevision !== this.scope.scopeRevision) throw new Error('来源范围已变化，请重新确认联系人。');
    return this.scope;
  }
  async refresh(request: ContactSelection) {
    const scope = this.assertScope(request);
    this.pollCount = 0;
    await this.read(scope);
  }
  async delete(request: SourceDeletionRequest) {
    const scope = this.assertScope(request);
    if (this.state.busySourceId || this.state.phase !== 'ready' || !this.state.sources.some((source) => source.sourceId === request.sourceId)) throw new Error('来源目录已变化，请刷新后确认。');
    this.cancel(); const revision = this.revision;
    this.publish({ busySourceId: request.sourceId, error: null });
    const current = () => this.scope === scope && revision === this.revision && scope.generation === this.backend.getConnectionGeneration();
    try {
      const taskId = await this.tracking.delete(scope.contactId, request.sourceId, scope.generation);
      if (!current()) return;
      this.verified.delete(taskId); this.pollCount = 0;
      await this.read(scope);
    } catch {
      if (current()) this.publish({ error: '删除结果尚未确认，请刷新来源核对原任务；不要将请求失败理解为未执行。' });
    } finally { if (current()) this.publish({ busySourceId: null }); }
  }
  private async read(scope: Scope) {
    this.cancel(); const revision = this.revision; const pending = new AbortController(); this.pending = pending;
    const current = () => this.scope === scope && revision === this.revision && scope.generation === this.backend.getConnectionGeneration();
    this.publish({ phase: 'loading', sources: [], error: null });
    try {
      const response = await this.backend.requestJson({ method: 'GET', path: `/api/contacts/${scope.contactId}/sources`, signal: pending.signal });
      if (!current() || response.generation !== scope.generation) return;
      const entries = deletionSources(response.data);
      const sources = await Promise.all(entries.map(async ({ source, taskId }) => {
        if (!taskId) return source;
        const result = await this.backend.requestJson({ method: 'GET', path: `/api/tasks/status?contact_id=${scope.contactId}&task_id=${taskId}`, signal: pending.signal });
        if (result.generation !== scope.generation) throw new Error('连接已变化。');
        return { ...source, task: deletionTask(result.data, taskId) };
      }));
      if (!current()) return;
      for (const source of sources) if (source.task?.status === 'succeeded' && !this.verified.has(source.task.taskId)) {
        await this.onSourceChanged(scope.contactId);
        if (!current()) return;
        this.verified.add(source.task.taskId);
      }
      this.publish({ phase: 'ready', sources, busySourceId: null });
      if (sources.some((source) => source.task && ['queued', 'running', 'verifying'].includes(source.task.status))) {
        if (++this.pollCount <= 30) this.poll = setTimeout(() => { if (current()) void this.read(scope); }, 500);
        else this.publish({ error: '删除仍未确认完成，请稍后刷新原任务。' });
      }
    } catch { if (current()) this.publish({ phase: 'failed', sources: [], busySourceId: null, error: '来源或删除任务读取失败，尚不能确认已删除，请重试刷新。' }); }
    finally { if (this.pending === pending) this.pending = undefined; }
  }
  private cancel() { ++this.revision; this.pending?.abort(); this.pending = undefined; clearTimeout(this.poll); this.poll = undefined; }
  private publish(update: Partial<SourceDeletionState>) { this.state = { ...this.state, ...update, revision: this.state.revision + 1 }; for (const listener of this.listeners) listener(this.getState()); }
}
