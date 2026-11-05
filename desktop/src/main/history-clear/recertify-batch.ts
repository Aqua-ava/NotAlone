import { randomBytes } from 'node:crypto';
import type { HistoryRecertifyView } from '../../shared/history-clear-bridge';
import { historyRecertifyBatchLimitMax, type HistoryRecertifyBatchCurrent, type HistoryRecertifyBatchOverview, type HistoryRecertifyBatchStartRequest, type HistoryRecertifyBatchState } from '../../shared/history-recertify-batch-bridge';
import { BackendRequestFailure, type JsonRequest } from '../backend/json-client';
import type { BackendHost } from '../backend/host';
import type { HistoryActivityMutex } from './activity';
import { recertifyCandidateList, recertifyView, type RecertifyCandidate } from './recertify-read';

type BatchBackend = Pick<BackendHost, 'requestJson' | 'getConnectionGeneration' | 'onStateChanged'>;
export interface HistoryRecertifyBatchOptions {
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  createBatchId?: (now: number) => string;
  log?: (line: Record<string, unknown>) => void;
  /** 轮询从 2 秒逐步退到 5 秒，不再更短。 */
  pollInitialMs?: number;
  pollMaxMs?: number;
  /** 每位之间的短暂让出；不超过 1 秒。 */
  interContactMs?: number;
  /** 当前联系人在 running 下消息数/页数/阶段 10 分钟无变化视为停滞。 */
  stallMs?: number;
  /** 响应丢失后同键查询仍未看到接纳的最长等待。 */
  admissionGraceMs?: number;
  /** 进度查询连续失败的最长等待，随后整体中断。 */
  statusFailureGraceMs?: number;
  /** 取消后确认终态的最长等待。 */
  cancelConfirmMs?: number;
  /** `already_running` 时只读等待其终态的最长时间。 */
  existingWaitMs?: number;
}
type ResolvedOptions = Required<Pick<HistoryRecertifyBatchOptions, 'pollInitialMs' | 'pollMaxMs' | 'interContactMs' | 'stallMs' | 'admissionGraceMs' | 'statusFailureGraceMs' | 'cancelConfirmMs' | 'existingWaitMs'>>;

/** 批量与测试共用的失败分类：全部码取自 `recertify.ts`、`recertify-actions.ts` 与读取渠道实际可能返回的错误码。 */
export type HistoryRecertifyFailureAction = 'already_fixed' | 'skip' | 'transient' | 'interrupt' | 'authorization' | 'capability' | 'program' | 'unknown';
const alreadyFixedCodes = new Set(['history_recertify_not_required']);
// 联系人级：记录原因码后继续；只有真人能处理的来源/删除/资格问题。
const skipCodes = new Set([
  'history_recertify_source_changed', 'history_recertify_source_unverified',
  'history_recertify_deletion_pending', 'history_no_active_binding', 'history_recertify_stale', 'read_eligibility_stale',
  'history_recertify_page_limit', 'history_recertify_incomplete', 'history_recertify_suppression_unmapped',
  'history_recertify_terminal_alias_unmapped', 'history_recertify_legacy_proof_invalid',
]);
// 连接级：批量整体以 interrupted 结束，不自动恢复。
const interruptCodes = new Set([
  'history_recertify_interrupted', 'history_recertify_cancelled', 'history_native_closed', 'history_native_cancelled',
  'history_recertify_scope_changed', 'history_recertify_guard_lost', 'history_closed',
]);
// 授权级：同步总开关关闭、授权撤销或当前账号资格失效。
const authorizationCodes = new Set(['read_not_authorized', 'history_recertify_not_authorized', 'history_contact_not_found']);
// 能力级：本机读取工具无法完成完整来源守卫。
const capabilityCodes = new Set(['history_recertify_guard_required', 'history_operation_unsupported', 'history_scope_unverified', 'history_target_not_private', 'history_target_invalid']);
// 程序错误：请求身份冲突、状态或回包无法确认。
const programCodes = new Set([
  'history_recertify_request_conflict', 'history_recertify_not_found', 'history_request_invalid', 'history_request_failed',
  'history_recertify_unavailable', 'history_recertify_candidate_invalid', 'history_recertify_failed',
]);
// 其余读取渠道/快照错误按“可能是瞬时”的联系人级失败处理：连续 3 位同码即整体停止。
const transientPattern = /^history_(?:native|snapshot|protocol|delta|target|shard|schema|support|account|identity|metadata|source|boundary|scope|cursor|page|text|quote|image|program|artifact|nonce|checkpoint|tail|operation|request|guard)_/;
export function classifyHistoryRecertifyFailure(code: string): HistoryRecertifyFailureAction {
  if (alreadyFixedCodes.has(code)) return 'already_fixed';
  if (skipCodes.has(code) || code === 'history_recertify_already_running') return 'skip';
  if (interruptCodes.has(code)) return 'interrupt';
  if (authorizationCodes.has(code)) return 'authorization';
  if (capabilityCodes.has(code)) return 'capability';
  if (programCodes.has(code)) return 'program';
  if (transientPattern.test(code)) return 'transient';
  return 'unknown';
}
/** 批次标识：本地时间 yyyymmddHHMMSS + 4 位随机十六进制，满足请求键字符集。 */
export function createHistoryRecertifyBatchId(now: number): string {
  const date = new Date(now);
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${randomBytes(2).toString('hex')}`;
}
const requestKeyPattern = /^[A-Za-z0-9_.:@-]{1,200}$/;
const initialOverview: HistoryRecertifyBatchOverview = { phase: 'idle', total: 0, withUnsavedImages: 0, messageTotal: 0, imageUnsavedTotal: 0, fencedTotal: 0, readEnabled: false, error: null };
const initialState = (overview: HistoryRecertifyBatchOverview): HistoryRecertifyBatchState => ({ revision: 0, phase: 'idle', batchId: null, overview, total: 0,
  completed: 0, failedByCode: {}, skippedByCode: {}, alreadyFixed: 0, current: null, startedAt: null, finishedAt: null, stopRequested: false,
  limit: null, interruptedReason: null, aggregateComplete: null, error: null });
class BatchInterruption extends Error { constructor(readonly code: string, readonly category: string) { super(code); } }
class BatchProtocolFailure extends Error { constructor(readonly code: string) { super(code); } }
const uuids = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const json = (value: unknown) => JSON.stringify(value);
/** 回包格式不合约即整体停止：不把未知结构当成可继续的普通失败。 */
function parseView(value: unknown, contactId: string): HistoryRecertifyView {
  try { return recertifyView(value, contactId); }
  catch { throw new BatchProtocolFailure('history_recertify_response_invalid'); }
}
/**
 * 开发者批量来源重新认证编排器（ADR-173、规格 6.3–6.6）。
 * 单例、严格串行、一次确认覆盖启动时的候选快照；只调用现有 `history/recertify` 三个接口，
 * 请求键只按“批次-序号-联系人”生成并绝不换键重发。批量状态只在内存中，不持久化。
 */
export class HistoryRecertifyBatchController {
  private state: HistoryRecertifyBatchState = initialState(initialOverview);
  private readonly listeners = new Set<(state: HistoryRecertifyBatchState) => void>();
  private readonly options: ResolvedOptions;
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly createBatchId: (now: number) => string;
  private readonly unsubscribeBackend: () => void;
  private disposed = false;
  private running: Promise<void> | undefined;
  private activeRequest: AbortController | undefined;
  private wakeSleep: (() => void) | undefined;
  private activeBatchId: string | null = null;
  private stopRequested = false;
  private startGeneration: number | undefined;
  private currentOperation: { contactId: string; requestKey: string } | null = null;
  private streakCode: string | null = null;
  private streakCount = 0;
  private unknownStreak = 0;
  constructor(private readonly backend: BatchBackend, private readonly activity: HistoryActivityMutex,
    private readonly singleActive: () => boolean, options: HistoryRecertifyBatchOptions = {}) {
    this.options = {
      pollInitialMs: options.pollInitialMs ?? 2000, pollMaxMs: options.pollMaxMs ?? 5000, interContactMs: options.interContactMs ?? 250,
      stallMs: options.stallMs ?? 600_000, admissionGraceMs: options.admissionGraceMs ?? 45_000, statusFailureGraceMs: options.statusFailureGraceMs ?? 90_000,
      cancelConfirmMs: options.cancelConfirmMs ?? 60_000, existingWaitMs: options.existingWaitMs ?? 600_000,
    };
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.createBatchId = options.createBatchId ?? createHistoryRecertifyBatchId;
    this.log = options.log ?? (() => {});
    this.unsubscribeBackend = backend.onStateChanged(() => this.synchronizeConnection());
  }
  private readonly log: (line: Record<string, unknown>) => void;
  getState(): HistoryRecertifyBatchState { return structuredClone(this.state); }
  onStateChanged(listener: (state: HistoryRecertifyBatchState) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopRequested = true;
    this.abortCurrent();
    this.releaseBatch();
    this.unsubscribeBackend();
    this.listeners.clear();
  }
  private get terminal(): boolean { return this.state.phase === 'finished' || this.state.phase === 'interrupted'; }
  private publish(): void {
    this.state = { ...this.state, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(structuredClone(this.state));
  }
  private patch(patch: Partial<HistoryRecertifyBatchState>): void { this.state = { ...this.state, ...patch }; this.publish(); }
  private patchCurrent(current: HistoryRecertifyBatchCurrent): void { this.patch({ current }); }
  private releaseBatch(): void {
    const batchId = this.activeBatchId;
    this.activeBatchId = null;
    if (batchId) this.activity.endBatch(batchId);
  }
  private abortCurrent(): void {
    this.activeRequest?.abort();
    this.activeRequest = undefined;
    const wake = this.wakeSleep;
    this.wakeSleep = undefined;
    wake?.();
  }
  private sleep(ms: number): Promise<void> {
    if (this.terminal) return Promise.resolve();
    return new Promise(resolve => {
      let settled = false;
      const wake = () => { if (settled) return; settled = true; if (this.wakeSleep === wake) this.wakeSleep = undefined; resolve(); };
      this.wakeSleep = wake;
      void this.delay(ms).then(wake, wake);
    });
  }
  private async request(options: JsonRequest, ignoreStop = false): Promise<{ generation: number; data: unknown }> {
    if (this.stopRequested && !ignoreStop) throw new BatchInterruption('history_recertify_cancelled', 'stop');
    const controller = new AbortController();
    this.activeRequest = controller;
    try { return await this.backend.requestJson({ ...options, signal: controller.signal }); }
    finally { if (this.activeRequest === controller) this.activeRequest = undefined; }
  }
  private assertGeneration(generation: number): void {
    if (this.backend.getConnectionGeneration() !== generation) throw new BatchInterruption('connection_changed', 'connection');
  }
  private synchronizeConnection(): void {
    if (this.disposed || this.terminal || this.startGeneration === undefined) return;
    if (this.backend.getConnectionGeneration() !== this.startGeneration) this.interrupt('connection_changed');
  }
  private interrupt(code: string): void {
    if (this.terminal) return;
    this.abortCurrent();
    this.releaseBatch();
    this.log({ event: 'batch_interrupted', batch_id: this.state.batchId, code });
    this.state = { ...this.state, phase: 'interrupted', finishedAt: this.now(), current: null, interruptedReason: code };
    this.publish();
  }
  private finishRun(): void {
    if (this.terminal) return;
    const elapsed = this.state.startedAt === null ? null : this.now() - this.state.startedAt;
    const summary = { event: 'batch_finished', batch_id: this.state.batchId, total: this.state.total, completed: this.state.completed,
      failed_by_code: this.state.failedByCode, skipped_by_code: this.state.skippedByCode, already_fixed: this.state.alreadyFixed, elapsed_ms: elapsed };
    this.releaseBatch();
    this.state = { ...this.state, phase: 'finished', finishedAt: this.now(), current: null };
    this.publish();
    this.log(summary);
  }
  private failRun(error: unknown): void {
    if (this.terminal || this.disposed) return;
    const code = error instanceof BatchInterruption ? error.code : error instanceof BatchProtocolFailure ? error.code : 'history_recertify_failed';
    this.abortCurrent();
    this.releaseBatch();
    this.log({ event: 'batch_interrupted', batch_id: this.state.batchId, code });
    this.state = { ...this.state, phase: 'interrupted', finishedAt: this.now(), current: null, interruptedReason: code };
    this.publish();
  }
  private async fetchCandidates(): Promise<ReturnType<typeof recertifyCandidateList>> {
    const generation = this.backend.getConnectionGeneration();
    if (generation === undefined) throw new Error('本机服务尚未连接。');
    const response = await this.backend.requestJson({ method: 'GET', path: '/api/history/recertify/candidates', timeoutMs: 10_000 });
    if (response.generation !== generation) throw new Error('本机服务连接已变化。');
    return recertifyCandidateList(response.data);
  }
  async refreshOverview(): Promise<void> {
    if (this.disposed) throw new Error('批量修复不可用。');
    if (this.state.phase === 'running' || this.state.phase === 'stopping') return;
    this.patch({ overview: { ...this.state.overview, phase: 'loading', error: null } });
    try {
      const list = await this.fetchCandidates();
      if (this.disposed) return;
      this.patch({ overview: { phase: 'ready', total: list.total, withUnsavedImages: list.withUnsavedImages, messageTotal: list.messageTotal,
        imageUnsavedTotal: list.imageUnsavedTotal, fencedTotal: list.fencedTotal, readEnabled: list.readEnabled, error: null } });
    } catch {
      if (!this.disposed) this.patch({ overview: { ...this.state.overview, phase: 'failed', error: '暂时无法读取被围栏联系人，请检查本机服务后重试。' } });
    }
  }
  async start(request: HistoryRecertifyBatchStartRequest): Promise<void> {
    if (this.disposed) throw new Error('批量修复不可用。');
    if (this.state.phase === 'running' || this.state.phase === 'stopping') throw new Error('已有批量修复在进行，请先等待或停止。');
    if (this.singleActive()) throw new Error('联系人页有单个修复或清空操作正在进行，请结束后再开始批量修复。');
    if (request.confirmed !== true) throw new Error('批量修复需要明确确认。');
    const limit = request.limit;
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > historyRecertifyBatchLimitMax)) throw new Error('本次最多修复数量无效。');
    const generation = this.backend.getConnectionGeneration();
    if (generation === undefined) throw new Error('本机服务尚未连接，暂时不能开始批量修复。');
    const list = await this.fetchCandidates();
    if (!list.readEnabled) throw new Error('同步读取已关闭或授权已撤销，暂时不能开始批量修复。');
    const selected = list.contacts.filter(contact => contact.fenced && contact.eligible).slice(0, limit ?? Number.MAX_SAFE_INTEGER);
    if (!selected.length) throw new Error(list.fencedTotal > 0 ? '被围栏联系人当前没有有效读取授权，请检查同步设置。' : '当前没有被围栏的联系人，无需批量修复。');
    const batchId = this.createBatchId(this.now());
    if (!requestKeyPattern.test(batchId)) throw new Error('批量修复批次标识无效。');
    if (!this.activity.beginBatch(batchId)) throw new Error('已有批量修复在进行，请先等待或停止。');
    this.activeBatchId = batchId;
    this.startGeneration = generation;
    this.stopRequested = false;
    this.currentOperation = null;
    this.streakCode = null; this.streakCount = 0; this.unknownStreak = 0;
    this.state = { ...initialState(this.state.overview), revision: this.state.revision + 1, phase: 'running', batchId, total: selected.length,
      startedAt: this.now(), limit, aggregateComplete: this.state.aggregateComplete };
    this.publish();
    this.log({ event: 'batch_start', batch_id: batchId, total: selected.length, limit });
    this.running = this.execute(selected, generation).catch(error => this.failRun(error)).finally(() => { this.running = undefined; });
  }
  async stop(): Promise<void> {
    if (this.disposed) throw new Error('批量修复不可用。');
    if (this.state.phase === 'running') {
      this.stopRequested = true;
      this.patch({ stopRequested: true, phase: 'stopping' });
      this.abortCurrent();
      return;
    }
    if (this.state.phase === 'stopping') return;
    throw new Error('当前没有正在运行的批量修复。');
  }
  private async execute(selected: RecertifyCandidate[], generation: number): Promise<void> {
    for (let index = 0; index < selected.length; index++) {
      if (this.terminal) return;
      if (this.stopRequested) { this.finishRun(); return; }
      this.assertGeneration(generation);
      const candidate = selected[index];
      this.currentOperation = null;
      this.patchCurrent({ index: index + 1, stage: 'starting', messageCount: 0, pageCount: 0, startedAt: null });
      let probe: RecertifyCandidate | null = null;
      try { probe = await this.probeCandidate(candidate.contactId, generation); }
      catch (error) {
        if (this.terminal || this.disposed) return;
        if (this.stopRequested) { this.finishRun(); return; }
        throw error;
      }
      if (this.terminal) return;
      if (this.stopRequested) { this.finishRun(); return; }
      if (probe && !probe.fenced) {
        this.countAlreadyFixed(index);
      } else {
        const stopped = await this.recertifyOne(candidate, index, generation);
        if (this.terminal) return;
        if (stopped) { this.finishRun(); return; }
      }
      if (index % 5 === 4 || index === selected.length - 1) await this.recordAggregate(generation);
      if (index < selected.length - 1) await this.sleep(Math.min(1000, this.options.interContactMs));
      if (this.stopRequested && !this.terminal) { this.finishRun(); return; }
    }
    if (this.terminal) return;
    this.finishRun();
  }
  /** 返回 true 表示已按停止请求取消当前位并确认终态，主循环应结束。 */
  private async probeCandidate(contactId: string, generation: number): Promise<RecertifyCandidate | null> {
    let response: { generation: number; data: unknown };
    try {
      response = await this.request({ method: 'GET', path: `/api/history/recertify/candidates?contact_id=${encodeURIComponent(contactId)}`, timeoutMs: 10_000 });
    } catch (error) {
      if (this.terminal || this.stopRequested) return null;
      if (error instanceof BatchInterruption) throw error;
      if (this.backend.getConnectionGeneration() !== generation) throw new BatchInterruption('connection_changed', 'connection');
      // 复核只是优化：查询失败时仍由后端接纳阶段返回权威失败码。
      this.log({ event: 'candidate_probe_failed', batch_id: this.state.batchId, index: this.state.current?.index ?? null });
      return null;
    }
    if (response.generation !== generation) throw new BatchInterruption('connection_changed', 'connection');
    let list: ReturnType<typeof recertifyCandidateList>;
    try { list = recertifyCandidateList(response.data); }
    catch {
      this.log({ event: 'candidate_probe_failed', batch_id: this.state.batchId, index: this.state.current?.index ?? null });
      return null;
    }
    if (!list.readEnabled) throw new BatchInterruption('read_not_authorized', 'authorization');
    return list.contacts.find(contact => contact.contactId === contactId) ?? { contactId, fenced: false, eligible: false, storedMessageCount: 0, imageMessageCount: 0, imageUnsavedCount: 0 };
  }
  private async recertifyOne(candidate: RecertifyCandidate, index: number, generation: number): Promise<boolean> {
    const contactId = candidate.contactId;
    const requestKey = `batch-${this.state.batchId}-${String(index + 1).padStart(3, '0')}-${contactId}`;
    if (!requestKeyPattern.test(requestKey)) throw new BatchProtocolFailure('history_recertify_request_conflict');
    this.currentOperation = { contactId, requestKey };
    const admissionAt = this.now();
    let view: HistoryRecertifyView | null = null;
    let admissionUnknown = false;
    try {
      view = await this.admit(contactId, requestKey, generation);
    } catch (error) {
      if (this.terminal || this.disposed) return false;
      if (this.stopRequested) return await this.stopCurrent(contactId, requestKey, generation);
      if (error instanceof BatchInterruption || error instanceof BatchProtocolFailure) throw error;
      if (isHttpFailure(error)) {
        if (error.code === 'history_recertify_already_running') {
          await this.waitExisting(contactId, generation);
          this.currentOperation = null;
          this.recordOutcome('skip', error.code, index);
          return false;
        }
        this.currentOperation = null;
        this.applyFailure(error.code!, index);
        return false;
      }
      admissionUnknown = true;
    }
    if (this.terminal || this.disposed) return false;
    if (this.stopRequested) return await this.stopCurrent(contactId, requestKey, generation);
    if (view && ['completed', 'failed', 'interrupted'].includes(view.state)) { this.currentOperation = null; await this.settleTerminal(view, index, contactId); return false; }
    let lastProgressAt = this.now();
    let lastProgress = view ? `${view.stage}:${view.messageCount}:${view.pageCount}` : '';
    let pollMs = this.options.pollInitialMs;
    for (;;) {
      if (this.terminal || this.disposed) return false;
      if (this.stopRequested) return await this.stopCurrent(contactId, requestKey, generation);
      this.assertGeneration(generation);
      await this.sleep(pollMs);
      if (this.terminal || this.disposed) return false;
      if (this.stopRequested) return await this.stopCurrent(contactId, requestKey, generation);
      this.assertGeneration(generation);
      let next: HistoryRecertifyView;
      try { next = await this.status(contactId, requestKey, generation); }
      catch (error) {
        if (this.terminal || this.disposed) return false;
        if (this.stopRequested) return await this.stopCurrent(contactId, requestKey, generation);
        if (error instanceof BatchInterruption || error instanceof BatchProtocolFailure) throw error;
        if (isHttpFailure(error)) throw new BatchProtocolFailure(error.code ?? 'history_recertify_request_conflict');
        if (this.now() - admissionAt > this.options.statusFailureGraceMs) throw new BatchInterruption('history_recertify_status_unconfirmed', 'connection');
        pollMs = Math.min(this.options.pollMaxMs, pollMs + 1000);
        continue;
      }
      if (next.state === 'none') {
        if (this.now() - admissionAt > (admissionUnknown ? this.options.admissionGraceMs : this.options.statusFailureGraceMs)) {
          throw new BatchInterruption(admissionUnknown ? 'history_recertify_admission_unconfirmed' : 'history_recertify_status_unconfirmed', 'connection');
        }
        pollMs = Math.min(this.options.pollMaxMs, pollMs + 1000);
        continue;
      }
      if (['completed', 'failed', 'interrupted'].includes(next.state)) {
        this.currentOperation = null;
        await this.settleTerminal(next, index, contactId);
        return false;
      }
      const progress = `${next.stage}:${next.messageCount}:${next.pageCount}`;
      if (progress !== lastProgress) { lastProgress = progress; lastProgressAt = this.now(); }
      this.patchCurrent({ index: index + 1, stage: next.stage as HistoryRecertifyBatchCurrent['stage'], messageCount: next.messageCount, pageCount: next.pageCount, startedAt: next.startedAt });
      if (this.now() - lastProgressAt >= this.options.stallMs) {
        await this.watchdog(contactId, requestKey, index, generation);
        return false;
      }
      pollMs = Math.min(this.options.pollMaxMs, pollMs + 1000);
    }
  }
  private async admit(contactId: string, requestKey: string, generation: number): Promise<HistoryRecertifyView> {
    const response = await this.request({ method: 'POST', path: `/api/contacts/${contactId}/history/recertify`, body: { request_key: requestKey }, timeoutMs: 10_000 });
    if (response.generation !== generation) throw new BatchInterruption('connection_changed', 'connection');
    const view = parseView(response.data, contactId);
    if (view.requestKey !== requestKey) throw new BatchProtocolFailure('history_recertify_request_conflict');
    return view;
  }
  private async status(contactId: string, requestKey: string, generation: number): Promise<HistoryRecertifyView> {
    const response = await this.request({ method: 'GET', path: `/api/contacts/${contactId}/history/recertify?request_key=${encodeURIComponent(requestKey)}`, timeoutMs: 10_000 });
    if (response.generation !== generation) throw new BatchInterruption('connection_changed', 'connection');
    const view = parseView(response.data, contactId);
    // 尚未接纳时状态是 none 且没有请求键；只有非 none 状态必须精确匹配原键。
    if (view.state !== 'none' && view.requestKey !== requestKey) throw new BatchProtocolFailure('history_recertify_request_conflict');
    return view;
  }
  private async settleTerminal(view: HistoryRecertifyView, index: number, contactId: string): Promise<void> {
    if (view.state === 'completed') { this.countCompleted(index); return; }
    const code = view.failureCode ?? 'history_recertify_failed';
    if (code === 'history_recertify_already_running') {
      await this.waitExisting(contactId, this.backend.getConnectionGeneration());
      this.recordOutcome('skip', code, index);
      return;
    }
    this.applyFailure(code, index);
  }
  private applyFailure(code: string, index: number): void {
    const action = classifyHistoryRecertifyFailure(code);
    if (action === 'already_fixed') { this.countAlreadyFixed(index); return; }
    if (action === 'skip') { this.recordOutcome('skip', code, index); return; }
    if (action === 'transient') {
      const streak = this.recordOutcome('transient', code, index);
      if (streak >= 3) throw new BatchInterruption(code, 'same_code_three_times');
      return;
    }
    if (action === 'unknown') {
      const streak = this.recordOutcome('unknown', code, index);
      if (streak >= 3) throw new BatchInterruption(code, 'unknown_codes_three_times');
      return;
    }
    throw new BatchInterruption(code, action);
  }
  /** 记录联系人级结果并返回连续同类计数；普通完成/跳过会重置瞬时熔断计数。 */
  private recordOutcome(action: 'completed' | 'already_fixed' | 'skip' | 'transient' | 'unknown', code: string | null, index: number): number {
    if (action === 'completed') { this.countCompleted(index); return 0; }
    if (action === 'already_fixed') { this.countAlreadyFixed(index); return 0; }
    if (action === 'skip') {
      this.streakCode = null; this.streakCount = 0; this.unknownStreak = 0;
      this.skippedByCode(code!);
      this.logContact(index, 'skipped', code);
      return 0;
    }
    if (action === 'transient') {
      this.unknownStreak = 0;
      if (this.streakCode === code) this.streakCount++; else { this.streakCode = code; this.streakCount = 1; }
      this.failedByCode(code!);
      this.logContact(index, 'failed', code);
      return this.streakCount;
    }
    this.streakCode = null; this.streakCount = 0; this.unknownStreak++;
    this.failedByCode(code!);
    this.logContact(index, 'failed', code);
    return this.unknownStreak;
  }
  private countCompleted(index: number): void {
    this.streakCode = null; this.streakCount = 0; this.unknownStreak = 0;
    this.patch({ completed: this.state.completed + 1 });
    this.logContact(index, 'completed', null);
  }
  private countAlreadyFixed(index: number): void {
    this.streakCode = null; this.streakCount = 0; this.unknownStreak = 0;
    this.patch({ alreadyFixed: this.state.alreadyFixed + 1 });
    this.logContact(index, 'already_fixed', null);
  }
  private failedByCode(code: string): void { this.patch({ failedByCode: { ...this.state.failedByCode, [code]: (this.state.failedByCode[code] ?? 0) + 1 } }); }
  private skippedByCode(code: string): void { this.patch({ skippedByCode: { ...this.state.skippedByCode, [code]: (this.state.skippedByCode[code] ?? 0) + 1 } }); }
  private logContact(index: number, outcome: 'completed' | 'failed' | 'skipped' | 'already_fixed', code: string | null): void {
    // 只记录批次、序号、结果与原因码；不记录联系人名称、联系人 ID 或请求键。
    this.log({ event: 'contact_settled', batch_id: this.state.batchId, index: index + 1, outcome, code });
  }
  private async stopCurrent(contactId: string, requestKey: string, generation: number): Promise<boolean> {
    if (this.terminal || this.disposed) return true;
    this.patchCurrent({ index: this.state.current?.index ?? 0, stage: 'cancelling', messageCount: this.state.current?.messageCount ?? 0,
      pageCount: this.state.current?.pageCount ?? 0, startedAt: this.state.current?.startedAt ?? null });
    const terminal = await this.cancelAndConfirm(contactId, requestKey, generation);
    this.currentOperation = null;
    if (this.terminal) return true;
    // 停止必须确认当前位终态；无法确认时整体中断，不能谎报已停止。
    if (!terminal) throw new BatchInterruption('history_recertify_stop_unconfirmed', 'connection');
    if (terminal.state === 'completed') { this.countCompleted((this.state.current?.index ?? 1) - 1); return true; }
    this.streakCode = null; this.streakCount = 0; this.unknownStreak = 0;
    this.patch({ skippedByCode: { ...this.state.skippedByCode, [terminal?.failureCode ?? 'history_recertify_cancelled']: (this.state.skippedByCode[terminal?.failureCode ?? 'history_recertify_cancelled'] ?? 0) + 1 } });
    this.log({ event: 'contact_settled', batch_id: this.state.batchId, index: this.state.current?.index ?? null, outcome: 'stopped', code: terminal?.failureCode ?? null });
    return true;
  }
  private async watchdog(contactId: string, requestKey: string, index: number, generation: number): Promise<void> {
    this.log({ event: 'contact_stalled', batch_id: this.state.batchId, index: index + 1 });
    this.patchCurrent({ index: index + 1, stage: 'cancelling', messageCount: this.state.current?.messageCount ?? 0, pageCount: this.state.current?.pageCount ?? 0, startedAt: this.state.current?.startedAt ?? null });
    const terminal = await this.cancelAndConfirm(contactId, requestKey, generation);
    this.currentOperation = null;
    if (this.terminal || this.disposed) return;
    if (terminal?.state === 'completed') { this.countCompleted(index); return; }
    this.streakCode = null; this.streakCount = 0; this.unknownStreak = 0;
    // 看门狗取消属于联系人级失败，记录客户端稳定原因码后继续下一位。
    this.failedByCode('history_recertify_stalled');
    this.log({ event: 'contact_settled', batch_id: this.state.batchId, index: index + 1, outcome: 'failed', code: 'history_recertify_stalled' });
  }
  /** 只取消当前键并只读确认终态；不换键、不重新接纳。无法确认时返回 null 由调用方整体中断。 */
  private async cancelAndConfirm(contactId: string, requestKey: string, generation: number): Promise<HistoryRecertifyView | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.terminal || this.disposed) return null;
      try {
        const response = await this.request({ method: 'POST', path: `/api/contacts/${contactId}/history/recertify/cancel`, body: { request_key: requestKey }, timeoutMs: 10_000 }, true);
        if (response.generation !== generation) throw new BatchInterruption('connection_changed', 'connection');
        const view = parseView(response.data, contactId);
        if (view.requestKey !== requestKey) throw new BatchProtocolFailure('history_recertify_request_conflict');
        if (['completed', 'failed', 'interrupted'].includes(view.state)) return view;
        break;
      } catch (error) {
        if (error instanceof BatchInterruption || error instanceof BatchProtocolFailure) throw error;
        if (isHttpFailure(error) && error.code === 'history_recertify_not_found') return null;
      }
    }
    const deadline = this.now() + this.options.cancelConfirmMs;
    let pollMs = this.options.pollInitialMs;
    for (;;) {
      if (this.terminal || this.disposed) return null;
      if (this.now() >= deadline) return null;
      try {
        const response = await this.request({ method: 'GET', path: `/api/contacts/${contactId}/history/recertify?request_key=${encodeURIComponent(requestKey)}`, timeoutMs: 10_000 }, true);
        if (response.generation !== generation) throw new BatchInterruption('connection_changed', 'connection');
        const view = parseView(response.data, contactId);
        if (view.requestKey !== requestKey) return null;
        if (['completed', 'failed', 'interrupted'].includes(view.state)) return view;
      } catch (error) {
        if (error instanceof BatchInterruption || error instanceof BatchProtocolFailure) throw error;
      }
      await this.sleep(pollMs);
      pollMs = Math.min(this.options.pollMaxMs, pollMs + 1000);
    }
  }
  private async waitExisting(contactId: string, generation: number | undefined): Promise<void> {
    if (generation === undefined) return;
    const deadline = this.now() + this.options.existingWaitMs;
    let pollMs = this.options.pollInitialMs;
    while (!this.terminal && !this.stopRequested && this.now() < deadline) {
      let view: HistoryRecertifyView | null = null;
      try {
        const response = await this.request({ method: 'GET', path: `/api/contacts/${contactId}/history/recertify`, timeoutMs: 10_000 });
        if (response.generation !== generation) throw new BatchInterruption('connection_changed', 'connection');
        view = parseView(response.data, contactId);
      } catch (error) {
        if (error instanceof BatchInterruption) throw error;
        if (this.terminal || this.stopRequested) return;
      }
      if (!view || view.state === 'none' || ['completed', 'failed', 'interrupted'].includes(view.state)) return;
      await this.sleep(pollMs);
      pollMs = Math.min(this.options.pollMaxMs, pollMs + 1000);
    }
  }
  private async recordAggregate(generation: number): Promise<void> {
    try {
      const response = await this.backend.requestJson({ method: 'GET', path: '/api/sync/status', timeoutMs: 10_000 });
      if (response.generation !== generation) return;
      const data = response.data as { cli_history_coverages?: unknown } | null;
      const coverages = Array.isArray(data?.cli_history_coverages) ? data.cli_history_coverages as { phase?: unknown }[] : [];
      const complete = coverages.filter(row => row && row.phase === 'complete').length;
      this.patch({ aggregateComplete: complete });
      this.log({ event: 'aggregate', batch_id: this.state.batchId, complete });
    } catch { /* 汇总读取只用于记录覆盖数量，失败不改变批量结果。 */ }
  }
}
function isHttpFailure(error: unknown): error is BackendRequestFailure & { code: string } {
  return error instanceof BackendRequestFailure && error.kind === 'response' && typeof error.code === 'string';
}
