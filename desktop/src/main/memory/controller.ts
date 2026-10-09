import type { MemoryAdditionRequest, MemoryCandidateRequest, MemoryCorrectionRequest, MemoryReadingState, MemoryReadRequest, MemoryRemovalRequest, MemorySectionName } from '../../shared/memory-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { activeMemories, memorySources, pendingCandidates } from './read';

const sections: MemorySectionName[] = ['contact', 'owner', 'pending', 'sources'];
const empty = (): Pick<MemoryReadingState, MemorySectionName> => ({
  contact: { phase: 'idle', items: [] }, owner: { phase: 'idle', items: [] },
  pending: { phase: 'idle', items: [] }, sources: { phase: 'idle', items: [] },
});
type Scope = { generation: number; contactId: string; scopeRevision: number };

export class MemoryReadingController {
  private state: MemoryReadingState = { revision: 0, contactId: null, scopeRevision: 0, mutation: { phase: 'idle', message: '' }, ...empty() };
  private scope: Scope | undefined;
  private readonly operations = new Map<MemorySectionName, { revision: number; abort: AbortController }>();
  private operationRevision = 0;
  private mutation: { revision: number; abort: AbortController } | undefined;
  private readonly listeners = new Set<(state: MemoryReadingState) => void>();

  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession) {}
  getState(): MemoryReadingState { return structuredClone(this.state); }
  onStateChanged(listener: (state: MemoryReadingState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  synchronizeScope(): void {
    const generation = this.backend.getConnectionGeneration();
    const contact = this.contacts.getState();
    const allowed = generation !== undefined && contact.selectedContactId !== null
      && (contact.directoryPhase === 'ready' || contact.directoryPhase === 'loading')
      && contact.contacts.some((entry) => entry.contactId === contact.selectedContactId);
    const next = allowed ? { generation, contactId: contact.selectedContactId!, scopeRevision: contact.scopeRevision } : undefined;
    if (next?.generation === this.scope?.generation && next?.contactId === this.scope?.contactId
      && next?.scopeRevision === this.scope?.scopeRevision) return;
    for (const operation of this.operations.values()) operation.abort.abort();
    this.operations.clear();
    this.mutation?.abort.abort();
    this.mutation = undefined;
    this.scope = next;
    this.publish({ contactId: next?.contactId ?? null, scopeRevision: contact.scopeRevision, mutation: { phase: 'idle', message: '' }, ...empty() });
  }
  async refresh(request: MemoryReadRequest): Promise<void> {
    this.synchronizeScope();
    const scope = this.scope;
    if (!scope || request.contactId !== scope.contactId || request.scopeRevision !== scope.scopeRevision) {
      throw new Error('资料范围已失效，请重新确认联系人。');
    }
    await Promise.all((request.section ? [request.section] : sections).map((section) => this.readSection(section, scope)));
  }
  async correct(request: MemoryCorrectionRequest): Promise<void> {
    this.synchronizeScope();
    const scope = this.scope;
    const previous = this.state[request.level].items.find((item) => item.memoryId === request.memoryId);
    if (!scope || request.contactId !== scope.contactId || request.scopeRevision !== scope.scopeRevision
      || !['owner', 'contact'].includes(request.level) || this.state[request.level].phase !== 'ready' || !previous
      || previous.revision !== request.revision || this.mutation) throw new Error('资料范围或版本已失效，请刷新后再修正。');
    const path = request.level === 'owner' ? `/api/memories/owner/${request.memoryId}/correct`
      : `/api/contacts/${scope.contactId}/memories/${request.memoryId}/correct`;
    await this.writeAndRefresh(scope, path, { text: request.text, category: request.category }, [request.level]);
  }
  async add(request: MemoryAdditionRequest): Promise<void> {
    this.synchronizeScope();
    const scope = this.scope;
    if (!scope || request.contactId !== scope.contactId || request.scopeRevision !== scope.scopeRevision
      || !['owner', 'contact'].includes(request.level) || this.mutation) throw new Error('资料范围已失效，请刷新后再补充。');
    const body = { text: request.text, category: request.category,
      ...(request.level === 'contact' ? { contact_id: scope.contactId } : {}) };
    await this.writeAndRefresh(scope, `/api/memories/manual-${request.level}`, body,
      request.level === 'contact' ? ['contact', 'sources'] : ['owner']);
  }
  async remove(request: MemoryRemovalRequest): Promise<void> {
    this.synchronizeScope();
    const scope = this.scope;
    const previous = this.state[request.level].items.find((item) => item.memoryId === request.memoryId);
    if (!scope || request.contactId !== scope.contactId || request.scopeRevision !== scope.scopeRevision
      || this.state[request.level].phase !== 'ready' || !previous || previous.revision !== request.revision
      || this.mutation) throw new Error('资料范围或版本已失效，请刷新后再删除。');
    const path = request.level === 'owner' ? `/api/memories/owner/${request.memoryId}/delete`
      : `/api/contacts/${scope.contactId}/memories/${request.memoryId}/delete`;
    await this.writeAndRefresh(scope, path, {}, [request.level]);
  }
  async confirmCandidate(request: MemoryCandidateRequest): Promise<void> {
    this.synchronizeScope();
    const scope = this.scope;
    const candidate = this.state.pending.items.find((item) => item.candidateId === request.candidateId);
    if (!scope || request.contactId !== scope.contactId || request.scopeRevision !== scope.scopeRevision
      || this.state.pending.phase !== 'ready' || !candidate || this.mutation) throw new Error('候选范围已失效，请刷新后再确认。');
    await this.writeAndRefresh(scope, `/api/contacts/${scope.contactId}/memory-candidates/${request.candidateId}/confirm`,
      {}, ['pending', candidate.subject === 'self' ? 'owner' : 'contact']);
  }
  private async writeAndRefresh(scope: Scope, path: string, body: unknown, sections: MemorySectionName[]): Promise<void> {
    const operation = { revision: ++this.operationRevision, abort: new AbortController() };
    this.mutation = operation;
    this.publish({ mutation: { phase: 'working', message: '正在处理并核对资料…' } });
    const current = () => { this.synchronizeScope(); return this.scope === scope && this.mutation === operation; };
    try {
      const result = await this.backend.requestJson({ method: 'POST', path, body, signal: operation.abort.signal });
      if (!current() || result.generation !== scope.generation) return;
      const refreshed = await Promise.all(sections.map((section) => this.readSection(section, scope)));
      if (!current()) return;
      if (!refreshed.every(Boolean)) throw new Error('资料已提交，但当前列表核对失败，请刷新确认结果。');
      this.publish({ mutation: { phase: 'success', message: '资料操作已完成并重新核对。' } });
    } catch {
      if (current()) this.publish({ mutation: { phase: 'error', message: '未能完成资料操作与核对，请刷新确认后重试。' } });
    } finally { if (this.mutation === operation) this.mutation = undefined; }
  }
  private async readSection(section: MemorySectionName, scope: Scope): Promise<boolean> {
    this.operations.get(section)?.abort.abort();
    const operation = { revision: ++this.operationRevision, abort: new AbortController() };
    this.operations.set(section, operation);
    this.publish({ [section]: { phase: 'loading', items: [] } });
    const current = () => {
      this.synchronizeScope();
      return this.scope === scope && this.operations.get(section)?.revision === operation.revision;
    };
    const contactPath = `/api/contacts/${scope.contactId}`;
    const paths = { contact: `${contactPath}/memories`, owner: '/api/memories/owner',
      pending: `${contactPath}/memory-candidates`, sources: `${contactPath}/sources` };
    try {
      const result = await this.backend.requestJson({ method: 'GET', path: paths[section], signal: operation.abort.signal });
      if (!current() || result.generation !== scope.generation) return false;
      switch (section) {
        case 'contact': this.publish({ contact: { phase: 'ready', items: activeMemories(result.data, 'contact', scope.contactId) } }); break;
        case 'owner': this.publish({ owner: { phase: 'ready', items: activeMemories(result.data, 'owner', scope.contactId) } }); break;
        case 'pending': this.publish({ pending: { phase: 'ready', items: pendingCandidates(result.data) } }); break;
        case 'sources': this.publish({ sources: { phase: 'ready', items: memorySources(result.data) } }); break;
      }
      return true;
    } catch {
      if (current()) this.publish({ [section]: { phase: 'error', items: [] } });
      return false;
    } finally {
      if (this.operations.get(section)?.revision === operation.revision) this.operations.delete(section);
    }
  }
  private publish(update: Partial<MemoryReadingState>): void {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState());
  }
}
