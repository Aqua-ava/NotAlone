import { conditionCorrectionFields } from './condition-proposal';
import type { LayeredMemoryReadRequest, LayeredMemoryManagementRequest, MemoryAdditionRequest, MemoryCandidateRequest, MemoryCandidateUpdateRequest, MemoryCorrectionRequest, MemoryReadingState, MemoryReadRequest, MemoryRemovalRequest, MemorySectionName } from '../../shared/memory-bridge';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import type { ContactSession } from '../contacts/session';
import { listedMemories, memorySources, memoryVersions, pendingCandidates } from './read';
import type { ContactSelection } from '../../shared/contact-session-bridge';
import { contactRelationshipOverview, ownerFactsPreferencesOverview } from './overview-read';
import { layeredMemory } from './layered-read';
import { validCorrectionTarget, correctionBody, retryFactCorrection } from './layered-correction';

const sections: MemorySectionName[] = ['contact', 'owner', 'pending', 'sources'];
const empty = (): Pick<MemoryReadingState, MemorySectionName | 'history' | 'overview' | 'ownerOverview' | 'layeredMemory'> => ({
  contact: { phase: 'idle', items: [] }, owner: { phase: 'idle', items: [] },
  pending: { phase: 'idle', items: [] }, sources: { phase: 'idle', items: [] },
  history: { phase: 'idle', items: [], memoryId: null, level: null },
  overview: { phase: 'idle', value: null },
  ownerOverview: { phase: 'idle', value: null },
  layeredMemory: { phase: 'idle', value: null },
});
type Scope = { generation: number; contactId: string; scopeRevision: number };
type ProtectedReads = { scope: Scope; sections: Set<MemorySectionName> };

export class MemoryReadingController {
  private state: MemoryReadingState = { revision: 0, contactId: null, scopeRevision: 0, mutation: { phase: 'idle', message: '' }, ...empty() };
  private scope: Scope | undefined;
  private readonly operations = new Map<MemorySectionName, { revision: number; abort: AbortController }>();
  private ownerRequested = false;
  private operationRevision = 0;
  private mutation: { revision: number; abort: AbortController } | undefined;
  private historyOperation: { abort: AbortController } | undefined;
  private overviewOperation: { abort: AbortController } | undefined;
  private overviewRequested = false;
  private ownerOverviewOperation: { abort: AbortController } | undefined;
  private ownerOverviewRequested = false;
  private layeredOperation: { abort: AbortController } | undefined;
  private layeredRequested = false;
  private layeredTimer: ReturnType<typeof setTimeout> | undefined;
  private sourceDeletionDepth = 0;
  private sourceDeletionRevision = 0;
  private protectedReads: ProtectedReads | undefined;
  private readonly listeners = new Set<(state: MemoryReadingState) => void>();
  private readonly deletionListeners = new Set<(phase: 'started' | 'settled', origin?: 'owner-facts') => void>();

  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession) {}
  getState(): MemoryReadingState { return structuredClone(this.state); }
  onStateChanged(listener: (state: MemoryReadingState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onRecordDeletion(listener: (phase: 'started' | 'settled', origin?: 'owner-facts') => void): () => void {
    this.deletionListeners.add(listener);
    return () => this.deletionListeners.delete(listener);
  }
  private readonly ownerDependencyListeners = new Set<(phase: 'started' | 'settled') => void>();
  onOwnerDependenciesChanged(listener: (phase: 'started' | 'settled') => void) { this.ownerDependencyListeners.add(listener); return () => { this.ownerDependencyListeners.delete(listener); }; }
  private readonly ownerContextListeners = new Set<(phase: 'started' | 'settled') => void | Promise<void>>();
  onOwnerContextChanged(listener: (phase: 'started' | 'settled') => void | Promise<void>) {
    this.ownerContextListeners.add(listener); return () => { this.ownerContextListeners.delete(listener); };
  }
  async ownerLayeredContextChanged(phase: 'started' | 'settled'): Promise<void> {
    await Promise.all([...this.ownerContextListeners].map(listener => listener(phase)));
  }
  private ownerFactsWriteDepth = 0;
  async ownerFactsChanged(phase: 'started' | 'settled'): Promise<void> {
    for (const listener of this.deletionListeners) listener(phase, 'owner-facts');
    this.ownerFactsWriteDepth = phase === 'started' ? this.ownerFactsWriteDepth + 1 : Math.max(0, this.ownerFactsWriteDepth - 1);
    // 另一本人入口写入时也撤下旧页面副本；取消令牌阻止迟到读取复活正文。
    this.operations.get('owner')?.abort.abort();
    this.operations.delete('owner');
    this.clearHistory();
    this.clearOverview();
    this.clearOwnerOverview();
    this.clearLayered();
    this.publish({ owner: { phase: 'idle', items: [] },
      ...(!this.ownerFactsWriteDepth ? { overview: { phase: 'idle' as const, value: null },
        ownerOverview: { phase: 'idle' as const, value: null }, layeredMemory: { phase: 'idle' as const, value: null } } : {}) });
    await this.ownerLayeredContextChanged(phase);
    this.synchronizeScope();
    if (phase === 'settled' && !this.ownerFactsWriteDepth && this.ownerRequested && this.scope) {
      await this.readSection('owner', this.scope);
    }
  }
  sourceDeletionChanged(phase: 'started' | 'settled'): void {
    for (const listener of this.ownerDependencyListeners) listener(phase);
    this.synchronizeScope();
    if (phase === 'started') {
      this.sourceDeletionDepth++;
      this.sourceDeletionRevision++;
      this.clearLayered();
    } else {
      this.sourceDeletionDepth = Math.max(0, this.sourceDeletionDepth - 1);
      if (!this.sourceDeletionDepth && this.layeredRequested && this.scope && !this.mutation) void this.readLayered(this.scope);
    }
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
    this.ownerRequested = false;
    this.historyOperation?.abort.abort();
    this.historyOperation = undefined;
    this.overviewOperation?.abort.abort();
    this.overviewOperation = undefined;
    this.overviewRequested = false;
    this.ownerOverviewOperation?.abort.abort();
    this.ownerOverviewOperation = undefined;
    this.ownerOverviewRequested = false;
    this.layeredOperation?.abort.abort();
    this.layeredOperation = undefined;
    this.layeredRequested = false;
    clearTimeout(this.layeredTimer);
    this.layeredTimer = undefined;
    this.mutation?.abort.abort();
    this.mutation = undefined;
    this.protectedReads = undefined;
    this.scope = next;
    this.publish({ contactId: next?.contactId ?? null, scopeRevision: contact.scopeRevision, mutation: { phase: 'idle', message: '' }, ...empty() });
  }
  async refreshOwnerProcessingResults(): Promise<void> {
    this.synchronizeScope();
    const scope = this.scope;
    if (scope && !this.mutation && !this.sourceDeletionDepth && this.state.owner.phase === 'ready' && !this.operations.has('owner')) {
      if (!await this.readSection('owner', scope, false, true)) throw new Error('本人记忆内容暂未刷新。');
    }
  }
  async refreshProcessingResults(request: ContactSelection): Promise<void> {
    this.synchronizeScope();
    const scope = this.scope;
    if (!scope || request.contactId !== scope.contactId || request.scopeRevision !== scope.scopeRevision) throw new Error('资料范围已变化。');
    if (this.mutation || this.sourceDeletionDepth) return;
    const refreshed = await Promise.all([
      ...sections.filter(section => this.state[section].phase === 'ready' && !this.operations.has(section))
        .map(section => this.readSection(section, scope, false, true)),
      ...(this.overviewRequested && !this.overviewOperation ? [this.readOverview(scope, true)] : []),
    ]);
    if (refreshed.some(success => !success)) throw new Error('记忆内容暂未刷新。');
  }
  async refresh(request: MemoryReadRequest): Promise<void> {
    this.synchronizeScope();
    const scope = this.scope;
    if (!scope || request.contactId !== scope.contactId || request.scopeRevision !== scope.scopeRevision) {
      throw new Error('资料范围已失效，请重新确认联系人。');
    }
    this.clearHistory();
    await Promise.all((request.section ? [request.section] : sections).map((section) => this.readSection(section, scope)));
  }
  async refreshOverview(request: ContactSelection): Promise<void> {
    this.synchronizeScope();
    const scope = this.scope;
    if (!scope || request.contactId !== scope.contactId || request.scopeRevision !== scope.scopeRevision) {
      throw new Error('概览范围已失效，请重新确认联系人。');
    }
    if (this.mutation) throw new Error('资料正在处理，请完成核对后再刷新概览。');
    this.overviewRequested = true;
    await this.readOverview(scope);
  }
  async refreshOwnerOverview(request: ContactSelection): Promise<void> {
    this.synchronizeScope();
    const scope = this.scope;
    if (!scope || request.contactId !== scope.contactId || request.scopeRevision !== scope.scopeRevision) {
      throw new Error('本人概览范围已失效，请重新确认联系人。');
    }
    if (this.mutation) throw new Error('资料正在处理，请完成核对后再刷新本人概览。');
    this.ownerOverviewRequested = true;
    await this.readOwnerOverview(scope);
  }
  releaseLayeredMemory(request: ContactSelection): void {
    this.synchronizeScope();
    if (request.contactId !== this.scope?.contactId || request.scopeRevision !== this.scope?.scopeRevision) return;
    this.layeredRequested = false;
    this.clearLayered();
  }
  async readLayeredMemory(request: LayeredMemoryReadRequest): Promise<void> {
    this.synchronizeScope();
    const scope = this.scope;
    if (!scope || request.contactId !== scope.contactId || request.scopeRevision !== scope.scopeRevision) {
      throw new Error('主题资料范围已失效，请重新确认联系人。');
    }
    if (this.sourceDeletionDepth) throw new Error('来源正在删除，请完成核对后再读取主题资料。');
    if (this.mutation) throw new Error('资料正在处理，请完成核对后再读取主题资料。');
    this.layeredRequested = true;
    await this.readLayered(scope, false, request.mappingCursor ?? null);
  }
  async manageLayeredMemory(request: LayeredMemoryManagementRequest): Promise<void> {
    this.synchronizeScope();
    const scope = this.scope, value = this.state.layeredMemory.value;
    const workAction = request.action === 'pause' || request.action === 'continue';
    const correction = request.action === 'summary-error' || request.action === 'fact-error';
    if (!scope || request.contactId !== scope.contactId || request.scopeRevision !== scope.scopeRevision || this.mutation
      || this.sourceDeletionDepth || this.state.layeredMemory.phase !== 'ready' || !value || value.settingsGeneration !== request.settingsGeneration
      || !['enable', 'refresh', 'disable', 'delete', 'withdraw-profile', 'pause', 'continue', 'summary-error', 'fact-error'].includes(request.action)
      || (correction && !validCorrectionTarget(value, request))
      || (workAction && (!value.workId || request.workRevision !== value.workRevision || value.workRevision < 1))
      || (!workAction && request.workRevision !== undefined)
      || (request.action === 'enable' && request.purposeConfirmed !== true)
      || (request.action === 'withdraw-profile' && (!value.profile || request.organizationGeneration !== value.organizationGeneration
        || request.profileVersionId !== value.profile.versionId))
      || (!correction && request.action !== 'withdraw-profile' && (request.organizationGeneration !== undefined || request.profileVersionId !== undefined))) {
      throw new Error('主题资料范围或设置已变化，请重新读取后操作。');
    }
    this.clearLayered();
    const operation = { revision: ++this.operationRevision, abort: new AbortController() };
    this.mutation = operation;
    if (correction) for (const listener of this.deletionListeners) listener('started');
    const sourceDeletionRevision = this.sourceDeletionRevision;
    this.publish({ mutation: { phase: 'working', message: '正在处理并核对主题资料…' } });
    const current = () => { this.synchronizeScope(); return this.scope === scope && this.mutation === operation && this.sourceDeletionRevision === sourceDeletionRevision; };
    try {
      const command = { method: 'POST' as const, path: `/api/contacts/${scope.contactId}/layered-memory/${request.action}`,
        body: { ...(workAction ? { work_revision: request.workRevision } : {}), settings_generation: request.settingsGeneration, ...(request.action === 'enable' ? { purpose_confirmed: true } : {}),
          ...(request.action === 'withdraw-profile' ? { organization_generation: request.organizationGeneration, profile_version_id: request.profileVersionId } : {}),
          ...(correction ? correctionBody(request) : {}) },
        signal: operation.abort.signal };
      const result = await retryFactCorrection(request.action === 'fact-error', current, () => this.backend.requestJson(command));
      if (!current() || result.generation !== scope.generation) return;
      const value = layeredMemory(result.data, scope.contactId);
      this.publish({ layeredMemory: { phase: 'ready', value }, mutation: { phase: 'success', message: request.action === 'delete'
        ? '主题资料整理结果已删除，本范围已关闭。底层记忆可另行管理。' : request.action === 'withdraw-profile'
          ? '本版长期背景已撤回，未自动恢复旧版。底层记忆可另行管理。' : '主题资料操作已完成并核对。' } });
    } catch (error) {
      if (!current()) return;
      await this.readLayered(scope);
      if (!current()) return;
      this.publish({ mutation: { phase: 'error', message: error instanceof BackendRequestFailure && error.status === 409
        ? '主题资料设置已变化，已撤下旧缓存并重新读取，请核对后重试。' : '主题资料操作未完成，已重新读取当前状态，请核对后重试。' } });
    } finally {
      if (correction) for (const listener of this.deletionListeners) listener('settled');
      if (this.mutation === operation) {
        this.mutation = undefined;
        this.scheduleLayered(scope);
        if (this.scope === scope && this.sourceDeletionRevision !== sourceDeletionRevision) {
          this.publish({ mutation: { phase: 'idle', message: '' } });
        }
        if (this.scope === scope && !this.sourceDeletionDepth && this.layeredRequested
          && this.sourceDeletionRevision !== sourceDeletionRevision) await this.readLayered(scope);
      }
    }
  }
  private scheduleLayered(scope: Scope): void {
    clearTimeout(this.layeredTimer);
    this.layeredTimer = undefined;
    const value = this.state.layeredMemory.value;
    if (!this.layeredRequested || this.scope !== scope || !value?.enabled
      || (value.runtimePolicy !== 'verified_items' && value.qualityStatus !== 'synthetic' && value.qualityStatus !== 'verified')) return;
    this.layeredTimer = setTimeout(() => {
      this.layeredTimer = undefined;
      this.synchronizeScope();
      if (this.scope === scope && !this.mutation && !this.sourceDeletionDepth) void this.readLayered(scope, true, value.mappingCursor);
    }, 1000);
    this.layeredTimer.unref();
  }
  private clearLayered(): void {
    clearTimeout(this.layeredTimer);
    this.layeredTimer = undefined;
    this.layeredOperation?.abort.abort();
    this.layeredOperation = undefined;
    this.publish({ layeredMemory: { phase: this.layeredRequested ? 'loading' : 'idle', value: null } });
  }
  private async readLayered(scope: Scope, background = false, mappingCursor: string | null = null): Promise<boolean> {
    if (!background) this.clearLayered();
    if (this.sourceDeletionDepth) return false;
    const operation = { abort: new AbortController() };
    this.layeredOperation = operation;
    if (!background) this.publish({ layeredMemory: { phase: 'loading', value: null } });
    const current = () => { this.synchronizeScope(); return this.scope === scope && this.layeredOperation === operation; };
    try {
      const result = await this.backend.requestJson({ method: 'GET', path: `/api/contacts/${scope.contactId}/layered-memory${mappingCursor ? `?mapping_cursor=${encodeURIComponent(mappingCursor)}` : ''}`, signal: operation.abort.signal });
      if (!current() || result.generation !== scope.generation) return false;
      this.publish({ layeredMemory: { phase: 'ready', value: layeredMemory(result.data, scope.contactId) } });
      this.scheduleLayered(scope);
      return true;
    } catch {
      if (current()) this.publish({ layeredMemory: { phase: 'error', value: null } });
      return false;
    } finally { if (this.layeredOperation === operation) this.layeredOperation = undefined; }
  }
  private async readOwnerOverview(scope: Scope): Promise<boolean> {
    if (this.ownerFactsWriteDepth) return false;
    this.ownerOverviewOperation?.abort.abort();
    const operation = { abort: new AbortController() };
    this.ownerOverviewOperation = operation;
    this.publish({ ownerOverview: { phase: 'loading', value: null } });
    const current = () => { this.synchronizeScope(); return this.scope === scope && this.ownerOverviewOperation === operation; };
    try {
      const result = await this.backend.requestJson({ method: 'GET', path: '/api/memories/owner/overview', signal: operation.abort.signal });
      if (!current() || result.generation !== scope.generation) return false;
      this.publish({ ownerOverview: { phase: 'ready', value: ownerFactsPreferencesOverview(result.data) } });
      return true;
    } catch {
      if (current()) this.publish({ ownerOverview: { phase: 'error', value: null } });
      return false;
    } finally { if (this.ownerOverviewOperation === operation) this.ownerOverviewOperation = undefined; }
  }
  private clearOverview(): void {
    this.overviewOperation?.abort.abort();
    this.overviewOperation = undefined;
    this.publish({ overview: { phase: this.overviewRequested ? 'loading' : 'idle', value: null } });
  }
  private clearOwnerOverview(): void {
    this.ownerOverviewOperation?.abort.abort();
    this.ownerOverviewOperation = undefined;
    this.publish({ ownerOverview: { phase: this.ownerOverviewRequested ? 'loading' : 'idle', value: null } });
  }
  private async readOverview(scope: Scope, background = false): Promise<boolean> {
    this.overviewOperation?.abort.abort();
    const operation = { abort: new AbortController() };
    this.overviewOperation = operation;
    if (!background || this.state.overview.phase !== 'ready') this.publish({ overview: { phase: 'loading', value: null } });
    const current = () => { this.synchronizeScope(); return this.scope === scope && this.overviewOperation === operation; };
    try {
      const result = await this.backend.requestJson({ method: 'GET',
        path: `/api/contacts/${scope.contactId}/relationship-overview`, signal: operation.abort.signal });
      if (!current() || result.generation !== scope.generation) return false;
      this.publish({ overview: { phase: 'ready', value: contactRelationshipOverview(result.data, scope.contactId) } });
      return true;
    } catch {
      if (current()) this.publish({ overview: { phase: 'error', value: null } });
      return false;
    } finally { if (this.overviewOperation === operation) this.overviewOperation = undefined; }
  }
  // 来源事件立即撤下旧快照；同范围未决写入仍须等待原提交复验，不能用客户端取消代替。
  async revalidateDeletedSource(_contactId: string): Promise<void> {
    for (const listener of this.ownerDependencyListeners) listener('started');
    for (const listener of this.ownerDependencyListeners) listener('settled');
    this.synchronizeScope();
    const scope = this.scope;
    if (!scope) return;
    const writing = this.mutation && this.protectedReads?.scope === scope ? this.protectedReads : undefined;
    if (!writing) {
      this.mutation?.abort.abort();
      this.mutation = undefined;
      this.protectedReads = undefined;
    }
    for (const operation of this.operations.values()) operation.abort.abort();
    this.operations.clear();
    this.clearHistory();
    this.clearOverview();
    this.clearOwnerOverview();
    this.clearLayered();
    this.publish({ ...empty(), overview: { phase: this.overviewRequested ? 'loading' : 'idle', value: null },
      ownerOverview: { phase: this.ownerOverviewRequested ? 'loading' : 'idle', value: null },
      layeredMemory: { phase: this.layeredRequested ? 'loading' : 'idle', value: null },
      ...(writing || this.state.mutation.phase === 'error' ? {} : { mutation: { phase: 'idle' as const, message: '' } }) });
    const currentSections = sections.filter((section) => !writing?.sections.has(section));
    const results = await Promise.all([...currentSections.map((section) => this.readSection(section, scope)),
      ...(this.overviewRequested && !writing?.sections.has('contact') && !writing?.sections.has('owner')
        ? [this.readOverview(scope)] : []),
      ...(this.ownerOverviewRequested && !writing?.sections.has('contact') && !writing?.sections.has('owner')
        ? [this.readOwnerOverview(scope)] : []),
      ...(this.layeredRequested && !this.sourceDeletionDepth && !writing?.sections.has('contact') && !writing?.sections.has('owner')
        ? [this.readLayered(scope)] : [])]);
    if (this.scope === scope && !results.every(Boolean)) throw new Error('来源已变化，资料仍需刷新核对。');
  }
  async openVersions(request: MemoryRemovalRequest): Promise<void> {
    this.synchronizeScope();
    const scope = this.scope;
    const active = this.state[request.level].items.find((item) => item.memoryId === request.memoryId);
    if (!scope || request.contactId !== scope.contactId || request.scopeRevision !== scope.scopeRevision
      || !active || active.revision !== request.revision || this.state[request.level].phase !== 'ready' || this.mutation) {
      throw new Error('资料范围或版本已失效，请刷新后再查看历史。');
    }
    this.clearHistory();
    const operation = { abort: new AbortController() };
    this.historyOperation = operation;
    this.publish({ history: { phase: 'loading', items: [], memoryId: active.memoryId, level: request.level } });
    const current = () => { this.synchronizeScope(); return this.scope === scope && this.historyOperation === operation; };
    let unavailable = false;
    try {
      const path = request.level === 'owner' ? `/api/contacts/${scope.contactId}/owner-memories/${active.memoryId}/versions`
        : `/api/contacts/${scope.contactId}/memories/${active.memoryId}/versions`;
      const result = await this.backend.requestJson({ method: 'GET', path, signal: operation.abort.signal });
      if (!current() || result.generation !== scope.generation) return;
      const items = memoryVersions(result.data, request.level, scope.contactId);
      if (items[0]?.memoryId !== active.memoryId || items[0].revision !== active.revision || items[0].status !== 'active') {
        unavailable = true;
        throw new Error('版本已变化。');
      }
      this.publish({ history: { phase: 'ready', items, memoryId: active.memoryId, level: request.level } });
    } catch (error) {
      if (current()) {
        if (unavailable || error instanceof BackendRequestFailure && error.kind === 'response'
          && (error.status === 404 || error.status === 409)) {
          this.discardUnavailableVersion(request);
          if (this.overviewRequested) await this.readOverview(scope);
          if (this.ownerOverviewRequested) await this.readOwnerOverview(scope);
          if (this.layeredRequested) await this.readLayered(scope);
          if (!current()) return;
        }
        this.publish({ history: { phase: 'error', items: [], memoryId: active.memoryId, level: request.level } });
      }
    } finally { if (this.historyOperation === operation) this.historyOperation = undefined; }
  }
  private discardUnavailableVersion(request: MemoryRemovalRequest): void {
    for (const listener of this.ownerDependencyListeners) listener('started');
    for (const listener of this.ownerDependencyListeners) listener('settled');
    this.clearOverview();
    this.clearOwnerOverview();
    this.clearLayered();
    // 只撤下已知失效的原版本，不把历史读取异常当作删除指令。
    for (const section of [request.level, 'pending'] as const) {
      const reading = this.operations.get(section);
      if (!reading) continue;
      reading.abort.abort();
      this.operations.delete(section);
      if (section === 'pending') this.publish({ pending: { phase: 'error', items: [] } });
    }
    this.publish({ [request.level]: { ...this.state[request.level], items: this.state[request.level].items.filter((item) =>
      item.memoryId !== request.memoryId || item.revision !== request.revision) } });
  }
  async revertAutoUpdate(request: MemoryRemovalRequest): Promise<void> {
    this.synchronizeScope();
    const scope = this.scope;
    const active = this.state[request.level].items.find((item) => item.memoryId === request.memoryId);
    const history = this.state.history;
    const viewed = history.phase === 'ready' && history.level === request.level ? history.items[0] : undefined;
    if (!scope || request.contactId !== scope.contactId || request.scopeRevision !== scope.scopeRevision
      || this.state[request.level].phase !== 'ready' || !active || active.revision !== request.revision
      || active.adoptionMethod !== 'auto' || !active.supersedesMemoryId || this.mutation
      || viewed?.memoryId !== active.memoryId || viewed.revision !== active.revision || viewed.canRevertAutoUpdate !== true) {
      throw new Error('自动版本或原始依据已变化，请刷新后再撤销。');
    }
    const path = request.level === 'owner' ? `/api/contacts/${scope.contactId}/owner-memories/${active.memoryId}/revert-auto-update`
      : `/api/contacts/${scope.contactId}/memories/${active.memoryId}/revert-auto-update`;
    await this.deleteAndRefresh(scope, path, [request.level, 'pending'], { expected_revision: active.revision }, true);
  }
  private clearHistory(): void {
    this.historyOperation?.abort.abort();
    this.historyOperation = undefined;
    this.publish({ history: { phase: 'idle', items: [], memoryId: null, level: null } });
  }
  async correct(request: MemoryCorrectionRequest): Promise<void> {
    this.synchronizeScope();
    const scope = this.scope;
    const previous = this.state[request.level].items.find((item) => item.memoryId === request.memoryId);
    if (!scope || request.contactId !== scope.contactId || request.scopeRevision !== scope.scopeRevision
      || !['owner', 'contact'].includes(request.level) || this.state[request.level].phase !== 'ready' || !previous
      || previous.status !== 'active' || previous.revision !== request.revision || this.mutation) throw new Error('资料范围或版本已失效，请刷新后再修正。');
    const path = request.level === 'owner' ? `/api/contacts/${scope.contactId}/owner-memories/${request.memoryId}/correct`
      : `/api/contacts/${scope.contactId}/memories/${request.memoryId}/correct`;
    const reading = this.protectReads(scope, [request.level, 'pending']);
    try {
      await this.writeAndRefresh(scope, path, { text: request.text, category: request.category, change_kind: request.changeKind ?? 'error_correction', ...conditionCorrectionFields(request.conditions) }, [request.level, 'pending']);
    } finally { this.settleProtectedReads(reading); }
  }
  async add(request: MemoryAdditionRequest): Promise<void> {
    this.synchronizeScope();
    const scope = this.scope;
    if (!scope || request.contactId !== scope.contactId || request.scopeRevision !== scope.scopeRevision
      || !['owner', 'contact'].includes(request.level) || this.mutation) throw new Error('资料范围已失效，请刷新后再补充。');
    const body = { text: request.text, category: request.category,
      ...(request.level === 'contact' ? { contact_id: scope.contactId } : {}) };
    await this.writeAndRefresh(scope, request.level === 'owner' ? `/api/contacts/${scope.contactId}/owner-memories` : '/api/memories/manual-contact', body,
      request.level === 'contact' ? ['contact', 'sources'] : ['owner']);
  }
  async remove(request: MemoryRemovalRequest): Promise<void> {
    this.synchronizeScope();
    const scope = this.scope;
    const previous = this.state[request.level].items.find((item) => item.memoryId === request.memoryId);
    if (!scope || request.contactId !== scope.contactId || request.scopeRevision !== scope.scopeRevision
      || this.state[request.level].phase !== 'ready' || !previous || previous.revision !== request.revision
      || this.mutation) throw new Error('资料范围或版本已失效，请刷新后再删除。');
    const path = request.level === 'owner' ? `/api/contacts/${scope.contactId}/owner-memories/${request.memoryId}/delete`
      : `/api/contacts/${scope.contactId}/memories/${request.memoryId}/delete`;
    this.publish({ [request.level]: { phase: 'ready',
      items: this.state[request.level].items.filter((item) => item.memoryId !== request.memoryId) } });
    await this.deleteAndRefresh(scope, path, [request.level, 'pending']);
  }
  async confirmCandidate(request: MemoryCandidateRequest): Promise<void> {
    this.synchronizeScope();
    const scope = this.scope;
    const candidate = this.state.pending.items.find((item) => item.candidateId === request.candidateId);
    if (!scope || request.contactId !== scope.contactId || request.scopeRevision !== scope.scopeRevision
      || this.state.pending.phase !== 'ready' || !candidate || this.mutation) throw new Error('候选范围已失效，请刷新后再确认。');
    await this.writeAndRefresh(scope, `/api/contacts/${scope.contactId}/memory-candidates/${request.candidateId}/confirm`,
      { correction_decision_ids: candidate.correctionReview?.map((review) => review.decisionId) ?? [] },
      ['pending', candidate.subject === 'self' ? 'owner' : 'contact']);
  }
  async discardCandidate(request: MemoryCandidateRequest): Promise<void> {
    this.synchronizeScope();
    const scope = this.scope;
    const candidate = this.state.pending.items.find((item) => item.candidateId === request.candidateId);
    if (!scope || request.contactId !== scope.contactId || request.scopeRevision !== scope.scopeRevision
      || this.state.pending.phase !== 'ready' || !candidate || this.mutation) throw new Error('候选范围已失效，请刷新后再丢弃。');
    await this.deleteAndRefresh(scope, `/api/contacts/${scope.contactId}/memory-candidates/${request.candidateId}/discard`, ['pending']);
  }
  async applyCandidateUpdate(request: MemoryCandidateUpdateRequest): Promise<void> {
    this.synchronizeScope();
    const scope = this.scope;
    const candidate = this.state.pending.items.find((item) => item.candidateId === request.candidateId);
    const level = candidate?.subject === 'self' ? 'owner' : 'contact';
    const previous = this.state[level].items.find((item) => item.memoryId === request.previousMemoryId);
    if (!scope || request.contactId !== scope.contactId || request.scopeRevision !== scope.scopeRevision
      || this.state.pending.phase !== 'ready' || !candidate || this.state[level].phase !== 'ready'
      || !previous || previous.status !== 'active' || previous.revision !== request.expectedRevision || this.mutation) {
      throw new Error('所选候选或旧版已变化，请刷新后再应用。');
    }
    await this.deleteAndRefresh(scope, `/api/contacts/${scope.contactId}/memory-candidates/${candidate.candidateId}/apply-update`,
      ['pending', level], { previous_memory_id: previous.memoryId, expected_revision: previous.revision,
        correction_decision_ids: candidate.correctionReview?.map((review) => review.decisionId) ?? [] }, true);
  }
  private async deleteAndRefresh(scope: Scope, path: string, sections: MemorySectionName[], body: unknown = {}, clearStaleVersions = false): Promise<void> {
    // 删除可能已提交而响应未知；起止都取消正文读取，期间不允许重新打开旧快照。
    const reading = this.protectReads(scope, sections);
    for (const listener of this.deletionListeners) listener('started');
    try { await this.writeAndRefresh(scope, path, body, sections, clearStaleVersions); }
    finally {
      this.settleProtectedReads(reading);
      for (const listener of this.deletionListeners) listener('settled');
    }
  }
  private protectReads(scope: Scope, sections: MemorySectionName[]): ProtectedReads {
    const reading = { scope, sections: new Set(sections) };
    this.protectedReads = reading;
    for (const section of sections) {
      this.operations.get(section)?.abort.abort();
      this.operations.delete(section);
    }
    if (sections.includes('pending')) this.publish({ pending: { phase: 'loading', items: [] } });
    return reading;
  }
  private settleProtectedReads(reading: ProtectedReads): void {
    if (this.protectedReads !== reading) return;
    for (const section of reading.sections) {
      this.operations.get(section)?.abort.abort();
      this.operations.delete(section);
    }
    this.protectedReads = undefined;
  }
  private async writeAndRefresh(scope: Scope, path: string, body: unknown, sections: MemorySectionName[], clearStaleVersions = false): Promise<void> {
    const reading = this.protectedReads?.scope === scope ? this.protectedReads : this.protectReads(scope, sections);
    const changesOverviewDependencies = sections.includes('contact') || sections.includes('owner');
    if (changesOverviewDependencies) for (const listener of this.ownerDependencyListeners) listener('started');
    const overviewAffected = changesOverviewDependencies && this.overviewRequested;
    const ownerOverviewAffected = changesOverviewDependencies && this.ownerOverviewRequested;
    const layeredAffected = changesOverviewDependencies && this.layeredRequested;
    if (changesOverviewDependencies) { this.clearOverview(); this.clearOwnerOverview(); this.clearLayered(); }
    this.clearHistory();
    const operation = { revision: ++this.operationRevision, abort: new AbortController() };
    this.mutation = operation;
    let checked = false;
    const refreshAfterWrite = () => Promise.all([...sections.map((section) => this.readSection(section, scope, true)),
      ...(overviewAffected ? [this.readOverview(scope)] : []),
      ...(ownerOverviewAffected ? [this.readOwnerOverview(scope)] : []),
      ...(layeredAffected ? [this.readLayered(scope)] : [])]);
    this.publish({ mutation: { phase: 'working', message: '正在处理并核对资料…' } });
    const current = () => { this.synchronizeScope(); return this.scope === scope && this.mutation === operation; };
    try {
      if (sections.includes('owner')) await this.ownerLayeredContextChanged('started');
      const result = await this.backend.requestJson({ method: 'POST', path, body, signal: operation.abort.signal });
      if (!current() || result.generation !== scope.generation) return;
      checked = true;
      const refreshed = await refreshAfterWrite();
      if (!current()) return;
      if (!refreshed.every(Boolean)) throw new Error('资料已提交，但当前列表核对失败，请刷新确认结果。');
      this.publish({ mutation: { phase: 'success', message: '资料操作已完成并重新核对。' } });
    } catch (error) {
      const backupCleanupRequired = error instanceof BackendRequestFailure && error.code === 'update_backup_cleanup_required';
      if (current()) {
        if (!checked) await refreshAfterWrite();
        if (!current()) return;
        // 来源事件可能取消提交后的核对；没有在途读取时结束等待，保留显式重试入口。
        if (overviewAffected && !this.overviewOperation && this.state.overview.phase === 'loading') {
          this.publish({ overview: { phase: 'error', value: null } });
        }
        if (ownerOverviewAffected && !this.ownerOverviewOperation && this.state.ownerOverview.phase === 'loading') {
          this.publish({ ownerOverview: { phase: 'error', value: null } });
        }
        if (layeredAffected && !this.layeredOperation && this.state.layeredMemory.phase === 'loading') {
          this.publish({ layeredMemory: { phase: 'error', value: null } });
        }
        // 提交冲突、来源失效或响应未知后，旧版本不能作为下次操作的依据。
        if (clearStaleVersions) for (const section of sections) this.publish({ [section]: { phase: 'error', items: [] } });
        this.publish({ mutation: { phase: 'error', backupCleanupRequired, message: backupCleanupRequired
          ? '更新备份尚未清理，删除未完成。请查看恢复说明并核验本机备份，再重试原删除。' : '未能完成资料操作与核对，请刷新确认后重试。' } });
      }
    } finally {
      if (this.mutation === operation) this.mutation = undefined;
      this.settleProtectedReads(reading);
      if (changesOverviewDependencies) for (const listener of this.ownerDependencyListeners) listener('settled');
      if (sections.includes('owner')) await this.ownerLayeredContextChanged('settled');
    }
  }
  private async readSection(section: MemorySectionName, scope: Scope, afterWrite = false, background = false): Promise<boolean> {
    if (section === 'owner') this.ownerRequested = true;
    if (section === 'owner' && this.ownerFactsWriteDepth) return false;
    if (!afterWrite && this.protectedReads?.scope === scope && this.protectedReads.sections.has(section)) return false;
    this.operations.get(section)?.abort.abort();
    const operation = { revision: ++this.operationRevision, abort: new AbortController() };
    this.operations.set(section, operation);
    if (!background) this.publish({ [section]: { phase: 'loading', items: [] } });
    const current = () => {
      this.synchronizeScope();
      return this.scope === scope && this.operations.get(section)?.revision === operation.revision;
    };
    const contactPath = `/api/contacts/${scope.contactId}`;
    const paths = { contact: `${contactPath}/memories`, owner: `${contactPath}/owner-memories`,
      pending: `${contactPath}/memory-candidates`, sources: `${contactPath}/sources` };
    try {
      const result = await this.backend.requestJson({ method: 'GET', path: paths[section], signal: operation.abort.signal });
      if (!current() || result.generation !== scope.generation) return false;
      switch (section) {
        case 'contact': this.publish({ contact: { phase: 'ready', items: listedMemories(result.data, 'contact', scope.contactId) } }); break;
        case 'owner': this.publish({ owner: { phase: 'ready', items: listedMemories(result.data, 'owner', scope.contactId) } }); break;
        case 'pending': this.publish({ pending: { phase: 'ready', items: pendingCandidates(result.data) } }); break;
        case 'sources': this.publish({ sources: { phase: 'ready', items: memorySources(result.data) } }); break;
      }
      return true;
    } catch {
      if (current() && !background) this.publish({ [section]: { phase: 'error', items: [] } });
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
