import { randomUUID } from 'node:crypto';
import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import type { SqliteStorage } from '../../storage/sqlite/client.ts';
import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';
import { ActiveHolders } from '../../storage/sqlite/deletion/holders.ts';
import { assertSupport, serializeSupport } from './actions.ts';
import type { HistoryChannel, HistoryCoverage, HistoryScope, HistorySupportReport, HistoryTarget } from './contracts.ts';
import type { HistoryClearContactGateway, HistoryClearChannelFactory } from './clear.ts';

/**
 * 06 明确重读：只有用户对该联系人明确选择时才建立新的身份核验、新读取许可与独立操作。
 * 普通重启/重选/后台重试不调用此服务；重读只写入历史来源，不恢复旧记忆、会话、媒体或旧证明。
 */
export interface HistoryResyncStatus {
  contactId: string; requestKey: string | null; state: 'none' | 'authorized' | 'active' | 'completed' | 'failed';
  authorizationId: string | null; grantId: string | null; cutoffOperationId: string | null;
  barrierGeneration: string | null; goalId: string | null; goalState: string | null;
  coverage: HistoryCoverage | null; completed: boolean;
}
interface RestoreGoal { id: string; state: string; coverageState: string; cursor: string | null; failureCode: string | null;
  target: HistoryTarget; report: HistorySupportReport }
interface StoredRestore {
  requestKey: string; authorizationId: string; contactId: string; grantId: string; selectionGeneration: string;
  barrierGeneration: string; cutoffOperationId: string | null; goalId: string | null;
  state: 'authorized' | 'active' | 'completed' | 'failed'; goal: RestoreGoal | null;
}
const fail = (code: string): never => { throw new StorageFailure(code); };
const clean = (value: unknown): string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value) ? value : fail('history_restore_request_invalid');
export class SqliteHistoryResyncService {
  private readonly storage: SqliteStorage;
  private readonly contacts: HistoryClearContactGateway;
  private readonly createChannel: HistoryClearChannelFactory;
  private readonly holders: ActiveHolders;
  private readonly options: { maxPages: number };
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private closed = false;

  constructor(storage: SqliteStorage, contacts: HistoryClearContactGateway, createChannel: HistoryClearChannelFactory,
    holders: ActiveHolders = new ActiveHolders(), options = { maxPages: 1000 }) {
    this.storage = storage; this.contacts = contacts; this.createChannel = createChannel;
    this.holders = holders; this.options = options;
  }
  private owner(): string { return this.contacts.ownerId; }
  private async stored(contactId: string): Promise<StoredRestore | null> {
    return await this.storage.execute<StoredRestore | null>('history.restoreStatus', { ownerId: this.owner(), contactId });
  }
  private async coverage(contactId: string): Promise<HistoryCoverage> {
    return await this.storage.execute<HistoryCoverage>('history.coverage', { ownerId: this.owner(), contactId });
  }
  private view(contactId: string, stored: StoredRestore | null, coverage: HistoryCoverage | null): HistoryResyncStatus {
    return { contactId, requestKey: stored?.requestKey ?? null, state: stored?.state ?? 'none',
      authorizationId: stored?.authorizationId ?? null, grantId: stored?.grantId ?? null,
      cutoffOperationId: stored?.cutoffOperationId ?? null, barrierGeneration: stored?.barrierGeneration ?? null,
      goalId: stored?.goalId ?? null, goalState: stored?.goal?.state ?? null,
      coverage, completed: stored?.state === 'completed' };
  }
  async status(contactId: string): Promise<HistoryResyncStatus> {
    if (this.closed) fail('history_closed');
    return this.view(contactId, await this.stored(contactId), await this.coverage(contactId));
  }
  private matchScope(scope: HistoryScope, report: HistorySupportReport): void {
    if (report.accountKey !== scope.accountKey || report.conversationKey !== scope.conversationKey
      || report.sourceGeneration !== scope.token.source_generation) fail('history_external_scope_changed');
  }
  private async inspect(channel: HistoryChannel, scope: HistoryScope, signal: AbortSignal): Promise<HistorySupportReport> {
    if (signal.aborted) fail('history_interrupted');
    const report = await channel.inspect(scope, signal);
    assertSupport(report);
    this.matchScope(scope, report);
    return report;
  }
  /** 用户明确重读入口：请求键幂等；同一联系人未完成的重读不并发创建第二份授权。 */
  async resync(contactId: string, options: { requestKey: string; signal?: AbortSignal }): Promise<HistoryResyncStatus> {
    if (this.closed) fail('history_closed');
    const requestKey = clean(options?.requestKey);
    if (this.active.has(contactId)) fail('history_restore_already_running');
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    this.active.set(contactId, { controller, done });
    const channel = this.createChannel();
    let release: (() => Promise<void>) | undefined;
    try {
      const before = await this.stored(contactId);
      if (before && before.requestKey === requestKey && before.state === 'completed') {
        return this.view(contactId, before, await this.coverage(contactId));
      }
      if (before && ['authorized', 'active'].includes(before.state) && before.requestKey !== requestKey) fail('history_restore_already_running');
      const resume = before && before.requestKey === requestKey && before.state === 'active' && before.goal ? before.goal : null;
      // 新授权前必须重新核验当前账号/联系人资格；关闭读取或撤销后不能凭旧资格重读。
      const token = await this.contacts.eligibility(contactId).catch(error => {
        throw error instanceof StorageFailure ? error : new StorageFailure('read_not_authorized');
      });
      const scope = await this.storage.execute<HistoryScope>('history.scope', { token });
      release = this.holders.register({ key: `history:restore_${contactId}`, ownerId: this.owner(), contactId,
        coversAllSources: false, generation: BigInt(token.data_generation),
        close: async () => { controller.abort(); await channel.close?.(); } });
      let report = await this.inspect(channel, scope, signal);
      let authorization = before;
      if (!authorization || authorization.requestKey !== requestKey) {
        authorization = await this.storage.execute<StoredRestore>('history.restoreBegin', {
          ownerId: this.owner(), contactId, requestKey, authorizationId: randomUUID(),
          verificationId: randomUUID(), grantId: randomUUID(), at: Date.now(),
          proof: { supportProfile: report.profileId, sourceGeneration: report.sourceGeneration,
            accountKey: report.accountKey, conversationKey: report.conversationKey } });
      }
      // 新许可生效后重新取当前资格；旧许可已撤销，旧请求不能继续使用。
      const current = await this.contacts.eligibility(contactId);
      const currentScope = await this.storage.execute<HistoryScope>('history.scope', { token: current });
      const currentReport = await this.inspect(channel, currentScope, signal);
      let goal = resume ?? authorization?.goal ?? null;
      if (goal && !['running', 'incomplete', 'complete'].includes(goal.state)) fail('history_restore_goal_conflict');
      if (goal && serializeSupport(goal.report) !== serializeSupport(currentReport)) fail('history_support_changed');
      if (!goal) {
        if (signal.aborted) fail('history_interrupted');
        const target = await channel.target(currentScope, signal);
        const created = await this.storage.execute<{ id: string; target: HistoryTarget }>('history.begin',
          { token: current, target, report: currentReport, id: randomUUID(), at: Date.now() });
        const attached = await this.storage.execute<StoredRestore & { attached: boolean }>('history.restoreAttach',
          { ownerId: this.owner(), contactId, requestKey, goalId: created.id });
        if (!attached.attached && attached.state !== 'completed') fail('history_restore_goal_conflict');
        goal = { id: created.id, state: 'running', coverageState: 'partial', cursor: null, failureCode: null, target: created.target, report: currentReport };
      }
      if (goal.state === 'complete') {
        await this.storage.execute('history.restoreComplete', { ownerId: this.owner(), contactId, requestKey, at: Date.now() });
        return this.view(contactId, await this.stored(contactId), await this.coverage(contactId));
      }
      const coverage = await this.readGoal(contactId, current, goal, currentReport, signal, channel, currentScope);
      await this.storage.execute('history.restoreComplete', { ownerId: this.owner(), contactId, requestKey, at: Date.now() });
      return this.view(contactId, await this.stored(contactId), coverage);
    } finally {
      try { if (release) await release(); } finally { try { await channel.close?.(); } catch { /* 已由 holder 关闭。 */ } }
      this.active.delete(contactId); finish();
    }
  }
  private async readGoal(contactId: string, token: ReadEligibility, goal: RestoreGoal, report: HistorySupportReport,
    signal: AbortSignal, channel: HistoryChannel, scope: HistoryScope): Promise<HistoryCoverage> {
    let cursor = goal.cursor;
    try {
      for (let index = 0; index < this.options.maxPages; index++) {
        if (signal.aborted) fail('history_interrupted');
        const page = await channel.page(scope, goal.target, cursor, signal);
        if (page.target !== goal.target.descriptor) fail('history_page_invalid');
        // 分段期间再次核验支持档；边界变化时不能把旧快照结果当作新资格。
        if (serializeSupport(await this.inspect(channel, scope, signal)) !== serializeSupport(report)) fail('history_support_changed');
        if (signal.aborted) fail('history_interrupted');
        const coverage = await this.storage.execute<HistoryCoverage>('history.acceptPage', {
          token, goalId: goal.id, captureId: randomUUID(), page, at: Date.now(), runtimeToken: this.storage.status.runtimeId });
        if (page.exhausted) return coverage;
        cursor = page.cursorOut;
      }
      return await this.storage.execute<HistoryCoverage>('history.interrupt', { token, goalId: goal.id, code: 'history_page_budget_exhausted' });
    } catch (error) {
      try { await this.storage.execute('history.interrupt', { token, goalId: goal.id,
        code: error instanceof StorageFailure ? error.code : 'history_read_interrupted' }); } catch { /* 旧资格不允许推进覆盖。 */ }
      throw error;
    }
  }
  async stop(contactId?: string): Promise<void> {
    const entries = [...this.active.entries()].filter(([id]) => !contactId || id === contactId).map(([, entry]) => entry);
    for (const entry of entries) entry.controller.abort();
    await Promise.all(entries.map(entry => entry.done));
  }
  async close(): Promise<void> { this.closed = true; await this.stop(); }
}
