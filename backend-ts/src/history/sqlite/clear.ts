import { randomUUID } from 'node:crypto';
import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import type { SqliteStorage } from '../../storage/sqlite/client.ts';
import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';
import { ActiveHolders } from '../../storage/sqlite/deletion/holders.ts';
import type { DeletionService } from '../../storage/sqlite/deletion/service.ts';
import type { HistoryChannel, HistoryScope } from './contracts.ts';
import { boundarySnapshotOf, HistoryBoundaryInvalid, prepareBoundaryCandidate, type HistoryBoundaryCandidate } from './boundary.ts';

/**
 * 06 清空聊天编排：立即推进 05 删除代次并封禁旧写入，再尝试只读边界快照 S(B)。
 * 边界能力未认证时只清理已保存资料并保持 boundary_pending，不显示清空成功。
 */
export interface HistoryClearContactGateway {
  readonly ownerId: string;
  eligibility(contactId: string): Promise<ReadEligibility>;
  validate(token: ReadEligibility): Promise<unknown>;
}
export type HistoryClearChannelFactory = () => HistoryChannel;
export type HistoryClearPhase = 'none' | 'boundary_pending' | 'cleaning' | 'cleanup_blocked' | 'completed';
export interface HistoryClearBoundaryView {
  conversationId: string; barrierGeneration: string; state: 'pending' | 'verified' | 'blocked';
  operationId: string; manifestSha256: string | null; memberCount: number | null;
  boundaryToken: string | null; reason: string | null; establishedAt: string | null;
}
export interface HistoryClearStatus {
  contactId: string; operationId: string | null; operationState: string | null;
  phase: HistoryClearPhase; completed: boolean; boundary: HistoryClearBoundaryView | null;
  failureCode: string | null; boundaryReason: string | null;
  storedMessages: number; storedSources: number; openGoals: number;
}
interface ActiveClear { controller: AbortController; done: Promise<void> }
const fail = (code: string): never => { throw new StorageFailure(code); };
const safeReason = (error: unknown, fallback: string): string => {
  if (error instanceof StorageFailure) return error.code;
  if (error instanceof HistoryBoundaryInvalid) return error.reason;
  return fallback;
};
export class SqliteHistoryClearService {
  private readonly storage: SqliteStorage;
  private readonly contacts: HistoryClearContactGateway;
  private readonly createChannel: HistoryClearChannelFactory;
  private readonly deletion: DeletionService;
  private readonly holders: ActiveHolders;
  private readonly options: { maxBoundaryAttempts: number };
  private readonly active = new Map<string, ActiveClear>();
  private readonly reasons = new Map<string, string>();
  private closed = false;

  constructor(storage: SqliteStorage, contacts: HistoryClearContactGateway, createChannel: HistoryClearChannelFactory,
    deletion: DeletionService, holders: ActiveHolders = new ActiveHolders(), options = { maxBoundaryAttempts: 3 }) {
    this.storage = storage; this.contacts = contacts; this.createChannel = createChannel;
    this.deletion = deletion; this.holders = holders; this.options = options;
  }
  private owner(): string { return this.contacts.ownerId; }
  private async status(contactId: string): Promise<HistoryClearStatus> {
    const snapshot = await this.storage.execute<HistoryClearStatus>('history.clearStatus', { ownerId: this.owner(), contactId });
    // 运行期原因只用于缺边界时展示；重启后仍以 boundary.pending/blocked 状态为准。
    return { ...snapshot, boundaryReason: this.reasons.get(contactId) ?? snapshot.boundary?.reason ?? null };
  }
  async clear(contactId: string, options: { signal?: AbortSignal } = {}): Promise<HistoryClearStatus> {
    if (this.closed) fail('history_closed');
    if (this.active.has(contactId)) fail('history_clear_already_running');
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    this.active.set(contactId, { controller, done });
    try {
      const before = await this.status(contactId);
      let operationId = before.operationId;
      let requestKey: string | null = null;
      if (!operationId || before.operationState === 'completed') {
        requestKey = `history.clear.${contactId}.${randomUUID()}`;
        const plan = await this.deletion.plan({ ownerId: this.owner(), requestKey, scope: { kind: 'contact_history', contactId } });
        operationId = plan.operationId;
      } else {
        // 恢复原删除操作：同一 request key 的 plan 幂等并重新施加 holder fence。
        const stored = await this.storage.execute<{ requestKey: string } | null>('history.clearRequest', { ownerId: this.owner(), operationId });
        if (!stored || !stored.requestKey) throw new StorageFailure('history_clear_operation_invalid');
        requestKey = stored.requestKey;
        await this.deletion.plan({ ownerId: this.owner(), requestKey, scope: { kind: 'contact_history', contactId } });
        // plan 返回既有操作快照；operationId 不变。
      }
      const begin = await this.storage.execute<{ state: 'pending' | 'verified' | 'unavailable'; conversationId: string | null;
        barrierGeneration: string; reason: string | null }>('history.clearBegin', { ownerId: this.owner(), contactId, operationId, at: Date.now() });
      if (begin.state === 'unavailable') {
        this.reasons.set(contactId, begin.reason ?? 'history_no_active_binding');
        await this.advance(operationId);
        return await this.status(contactId);
      }
      if (begin.state !== 'verified') {
        if (signal.aborted) {
          this.reasons.set(contactId, 'history_interrupted');
        } else {
          this.reasons.set(contactId, await this.captureBoundary(contactId, operationId, begin.barrierGeneration, signal));
        }
      } else {
        this.reasons.delete(contactId);
      }
      await this.advance(operationId);
      return await this.status(contactId);
    } finally {
      this.active.delete(contactId); finish();
    }
  }
  private async advance(operationId: string): Promise<void> {
    try { await this.deletion.advance({ ownerId: this.owner(), operationId }); }
    catch (error) { /* 进度已在 05 账本记录；状态查询会显示 blocked 及原因。 */ void error; }
  }
  /** 读取前、分段和接受前各复验一次资格；窗口变化只做有界重试。 */
  private async captureBoundary(contactId: string, operationId: string, barrierGeneration: string, signal: AbortSignal): Promise<string> {
    let token: ReadEligibility;
    // 任何非成功退出都让未生效候选失效（取消/关停/失败均不得留下可接受候选）。
    const invalidate = async (reason: string): Promise<string> => {
      try { await this.storage.execute('history.boundaryInvalidate', { ownerId: this.owner(), operationId, reason }); }
      catch { /* 失效写入失败保留原清空操作与 pending 状态，重试时先清理候选。 */ }
      return reason;
    };
    try { token = await this.contacts.eligibility(contactId); }
    catch (error) { return await invalidate(safeReason(error, 'read_not_authorized')); }
    const channel = this.createChannel();
    const stop = async () => { controller.abort(); await channel.close?.(); };
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    let release: (() => Promise<void>) | undefined;
    try {
      const scope = await this.storage.execute<HistoryScope>('history.scope', { token });
      release = this.holders.register({ key: `history:clear_${contactId}`, ownerId: this.owner(), contactId,
        coversAllSources: true, generation: BigInt(token.data_generation), close: stop });
      const boundary = boundarySnapshotOf(channel);
      if (!boundary) return await invalidate('history_boundary_unverified');
      let lastReason = 'history_boundary_unverified';
      for (let attempt = 1; attempt <= this.options.maxBoundaryAttempts; attempt++) {
        if (combined.aborted) return await invalidate('history_interrupted');
        try {
          await this.contacts.validate(token);
          const candidate = await boundary.call(channel, scope, combined) as HistoryBoundaryCandidate;
          // 取消/关停后返回的候选立即失效；不得在中断后持久化或接受 B。
          if (combined.aborted) return await invalidate('history_interrupted');
          await this.contacts.validate(token);
          const prepared = prepareBoundaryCandidate(scope, candidate);
          await this.contacts.validate(token);
          if (combined.aborted) return await invalidate('history_interrupted');
          await this.storage.execute('history.boundaryPersist', { ownerId: this.owner(), operationId, contactId,
            barrierGeneration, accountKey: scope.accountKey, conversationKey: scope.conversationKey, prepared });
          if (combined.aborted) return await invalidate('history_interrupted');
          await this.contacts.validate(token);
          if (combined.aborted) return await invalidate('history_interrupted');
          const accepted = await this.storage.execute<{ state: string }>('history.boundaryAccept', { ownerId: this.owner(), operationId, contactId, barrierGeneration, at: Date.now() });
          if (accepted.state === 'verified') return '';
          lastReason = 'history_boundary_pending';
        } catch (error) {
          const reason = safeReason(error, 'history_boundary_failed');
          lastReason = reason;
          if (error instanceof HistoryBoundaryInvalid && error.retryable && attempt < this.options.maxBoundaryAttempts) continue;
          break;
        }
      }
      return await invalidate(lastReason);
    } finally {
      try { if (release) await release(); } catch { /* 关闭失败保留原清空操作供重试。 */ }
      try { await channel.close?.(); } catch { /* 已由 holder close 关闭。 */ }
    }
  }
  async statusOf(contactId: string): Promise<HistoryClearStatus> {
    if (this.closed) fail('history_closed');
    return await this.status(contactId);
  }
  async stop(contactId?: string): Promise<void> {
    const entries = [...this.active.entries()].filter(([id]) => !contactId || id === contactId).map(([, entry]) => entry);
    for (const entry of entries) entry.controller.abort();
    await Promise.all(entries.map(entry => entry.done));
  }
  async close(): Promise<void> { this.closed = true; await this.stop(); }
}
