import { activeMemories } from './read';
import type { MemoryAdditionRequest, OwnerLayeredMemoryManagementRequest, OwnerLayeredMemoryState } from '../../shared/memory-bridge';
import type { BackendHost } from '../backend/host';
import { layeredMemory } from './layered-read';
import { validCorrectionTarget, correctionBody, retryFactCorrection } from './layered-correction';

// 本人范围仅绑定后端连接；联系人选择不参与本人请求和状态有效性。
export class OwnerLayeredMemoryController {
  private state: OwnerLayeredMemoryState = { revision: 0, phase: 'idle', value: null, mutation: { phase: 'idle', message: '' } };
  private generation: number | undefined;
  private operation: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private requested = false;
  private factsRequested = false;
  private factsOperation: AbortController | undefined;
  private deleting = 0;
  constructor(private backend: BackendHost, private publish: (state: OwnerLayeredMemoryState) => void, private factsChanged: (phase: 'started' | 'settled') => void) { this.generation = backend.getConnectionGeneration(); }
  getState() { return structuredClone(this.state); }
  private update(patch: Partial<OwnerLayeredMemoryState>) { this.state = { ...this.state, ...patch, revision: this.state.revision + 1 }; this.publish(this.getState()); }
  synchronize() {
    const generation = this.backend.getConnectionGeneration();
    if (this.generation === generation) return;
    this.generation = generation; this.requested = false; this.clear();
    this.factsRequested = false; this.factsOperation?.abort(); this.factsOperation = undefined;
    this.update({ memories: { phase: 'idle', items: [] }, phase: 'idle', value: null, mutation: { phase: 'idle', message: '' } });
  }
  sourceDeletionChanged(phase: 'started' | 'settled') {
    if (phase === 'started') { this.deleting++; this.clear(); this.factsOperation?.abort(); this.factsOperation = undefined; this.update({ memories: { phase: 'idle', items: [] }, phase: 'idle', value: null, mutation: { phase: 'idle', message: '' } }); }
    else { this.deleting = Math.max(0, this.deleting - 1); if (!this.deleting && this.requested) void this.read({}).catch(() => {}); if (!this.deleting && this.factsRequested) void this.readFacts().catch(() => {}); }
  }
  private clear() { clearTimeout(this.timer); this.timer = undefined; this.operation?.abort(); this.operation = undefined; }
  private schedule() {
    clearTimeout(this.timer);
    if (this.state.value?.enabled && this.state.value.qualityStatus === 'synthetic') {
      const mappingCursor = this.state.value.mappingCursor;
      this.timer = setTimeout(() => void this.read({ mappingCursor }, true).catch(() => {}), 1000); this.timer.unref();
    }
  }
  async read(request: { mappingCursor?: string | null }, background = false) {
    this.synchronize();
    if (this.generation === undefined || this.deleting || this.state.mutation.phase === 'working') throw new Error('本人资料暂不可读取。');
    this.requested = true; this.clear();
    const operation = new AbortController(), generation = this.generation; this.operation = operation;
    if (!background) this.update({ phase: 'loading', value: null });
    try {
      const result = await this.backend.requestJson({ method: 'GET', path: `/api/memories/owner/layered-memory${request.mappingCursor ? `?mapping_cursor=${encodeURIComponent(request.mappingCursor)}` : ''}`, signal: operation.signal });
      this.synchronize();
      if (this.operation !== operation || result.generation !== generation) return;
      this.update({ phase: 'ready', value: layeredMemory(result.data, null) }); this.schedule();
    } catch { if (this.operation === operation) this.update({ phase: 'error', value: null }); }
    finally { if (this.operation === operation) this.operation = undefined; }
  }
  async readFacts() {
    this.synchronize();
    if (this.generation === undefined || this.deleting || this.state.mutation.phase === 'working') throw new Error('本人底层资料暂不可读取。');
    this.factsRequested = true; this.factsOperation?.abort();
    const operation = new AbortController(), generation = this.generation; this.factsOperation = operation;
    this.update({ memories: { phase: 'loading', items: [] } });
    try {
      const result = await this.backend.requestJson({ method: 'GET', path: '/api/memories/owner', signal: operation.signal });
      this.synchronize();
      if (this.factsOperation !== operation || result.generation !== generation) return;
      this.update({ memories: { phase: 'ready', items: activeMemories(result.data, 'owner', null) } });
    } catch { if (this.factsOperation === operation) this.update({ memories: { phase: 'error', items: [] } }); }
    finally { if (this.factsOperation === operation) this.factsOperation = undefined; }
  }
  async changeFact(action: 'correct' | 'delete', request: { memoryId: string; revision: number; text?: string; category?: MemoryAdditionRequest['category'] }) {
    this.synchronize();
    if (this.state.memories?.phase !== 'ready' || !this.state.memories.items.some(item => item.memoryId === request.memoryId && item.revision === request.revision)) throw new Error('本人底层资料版本已变化，请重新读取。');
    await this.writeFact(`/api/memories/owner/${request.memoryId}/${action}`, action === 'correct' ? { text: request.text, category: request.category } : {});
  }
  async add(request: Pick<MemoryAdditionRequest, 'text' | 'category'>) { await this.writeFact('/api/memories/manual-owner', request); }
  private async writeFact(path: string, body: unknown) {
    this.synchronize();
    if (this.generation === undefined || this.deleting || this.state.mutation.phase === 'working') throw new Error('本人资料暂不可补充。');
    this.factsChanged('started');
    this.clear(); this.factsOperation?.abort(); this.factsOperation = undefined;
    const operation = new AbortController(), generation = this.generation; this.operation = operation;
    this.update({ memories: { phase: 'loading', items: [] }, phase: 'loading', value: null, mutation: { phase: 'working', message: '正在保存本人资料…' } });
    try {
      const result = await this.backend.requestJson({ method: 'POST', path, body, signal: operation.signal });
      this.synchronize();
      if (this.operation !== operation || result.generation !== generation) throw new Error('本人连接已变化，请核对是否保存。');
      this.update({ mutation: { phase: 'success', message: '本人资料已保存，请核对整理状态。' } });
      await this.read({});
      if (this.factsRequested) await this.readFacts();
    } catch (error) {
      if (this.operation === operation) {
        this.update({ phase: 'error', value: null, mutation: { phase: 'error', message: '本人资料保存结果未确认，请核对后再重试。' } });
        await this.read({});
        if (this.factsRequested) await this.readFacts();
      }
      throw error;
    } finally { this.factsChanged('settled'); if (this.operation === operation) this.operation = undefined; }
  }
  async manage(request: OwnerLayeredMemoryManagementRequest) {
    this.synchronize();
    const value = this.state.value;
    const work = request.action === 'pause' || request.action === 'continue';
    const correction = request.action === 'summary-error' || request.action === 'fact-error';
    if (this.generation === undefined || this.deleting || this.state.mutation.phase === 'working' || this.state.phase !== 'ready' || !value
      || request.settingsGeneration !== value.settingsGeneration
      || (correction && !validCorrectionTarget(value, request))
      || (work && (!value.workId || request.workRevision !== value.workRevision))
      || (request.action === 'withdraw-scenario' && (request.organizationGeneration !== value.organizationGeneration || !value.scenarios.some(item => item.versionId === request.scenarioVersionId)))
      || (request.action === 'withdraw-profile' && (!value.profile || request.profileVersionId !== value.profile.versionId || request.organizationGeneration !== value.organizationGeneration))) throw new Error('本人资料设置已变化，请重新读取。');
    this.clear();
    if (correction) this.factsChanged('started');
    const operation = new AbortController(), generation = this.generation; this.operation = operation;
    this.update({ phase: 'loading', value: null, mutation: { phase: 'working', message: '正在处理本人资料…' } });
    try {
      const command = { method: 'POST' as const, path: `/api/memories/owner/layered-memory/${request.action}`, signal: operation.signal,
        body: { settings_generation: request.settingsGeneration, ...(work ? { work_revision: request.workRevision } : {}),
          ...(request.action === 'enable' ? { purpose_confirmed: true } : {}),
          ...(request.action === 'withdraw-scenario' ? { organization_generation: request.organizationGeneration, scenario_version_id: request.scenarioVersionId } : {}),
          ...(request.action === 'withdraw-profile' ? { organization_generation: request.organizationGeneration, profile_version_id: request.profileVersionId } : {}),
          ...(correction ? correctionBody(request) : {}) } };
      const result = await retryFactCorrection(request.action === 'fact-error', () => {
        this.synchronize(); return this.operation === operation && this.generation === generation && !this.deleting;
      }, () => this.backend.requestJson(command));
      this.synchronize();
      if (this.operation !== operation || result.generation !== generation) return;
      this.update({ phase: 'ready', value: layeredMemory(result.data, null), mutation: { phase: 'success', message: '本人资料操作已完成并核对。' } }); this.schedule();
    } catch {
      if (this.operation !== operation) return;
      this.update({ phase: 'error', value: null, mutation: { phase: 'error', message: '本人资料操作未完成，请核对当前状态后重试。' } });
      await this.read({});
    } finally { if (correction) this.factsChanged('settled'); if (this.operation === operation) this.operation = undefined; }
  }
}
