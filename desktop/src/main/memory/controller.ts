import type { MemoryReadingState, MemoryReadRequest, MemorySectionName } from '../../shared/memory-bridge';
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
  private state: MemoryReadingState = { revision: 0, contactId: null, scopeRevision: 0, ...empty() };
  private scope: Scope | undefined;
  private readonly operations = new Map<MemorySectionName, { revision: number; abort: AbortController }>();
  private operationRevision = 0;
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
    this.scope = next;
    this.publish({ contactId: next?.contactId ?? null, scopeRevision: contact.scopeRevision, ...empty() });
  }
  async refresh(request: MemoryReadRequest): Promise<void> {
    this.synchronizeScope();
    const scope = this.scope;
    if (!scope || request.contactId !== scope.contactId || request.scopeRevision !== scope.scopeRevision) {
      throw new Error('资料范围已失效，请重新确认联系人。');
    }
    await Promise.all((request.section ? [request.section] : sections).map((section) => this.readSection(section, scope)));
  }
  private async readSection(section: MemorySectionName, scope: Scope): Promise<void> {
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
      if (!current() || result.generation !== scope.generation) return;
      switch (section) {
        case 'contact': this.publish({ contact: { phase: 'ready', items: activeMemories(result.data, 'contact', scope.contactId) } }); break;
        case 'owner': this.publish({ owner: { phase: 'ready', items: activeMemories(result.data, 'owner', scope.contactId) } }); break;
        case 'pending': this.publish({ pending: { phase: 'ready', items: pendingCandidates(result.data) } }); break;
        case 'sources': this.publish({ sources: { phase: 'ready', items: memorySources(result.data) } }); break;
      }
    } catch {
      if (current()) this.publish({ [section]: { phase: 'error', items: [] } });
    } finally {
      if (this.operations.get(section)?.revision === operation.revision) this.operations.delete(section);
    }
  }
  private publish(update: Partial<MemoryReadingState>): void {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState());
  }
}
