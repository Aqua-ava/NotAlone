/** 账号连接业务；候选核验与数据库授权不依赖 DSH 会话或模型。 */
import { enrollHistorySnapshot, type HistorySession } from './wechat-history-enrollment.ts';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { HostStorageError, type HostStorage } from './host-storage.ts';

export class WechatSetupConflict extends HostStorageError {
  constructor() { super('wechat_identity_conflict'); }
}
export class WechatProbeUnavailable extends Error {
  readonly code: string;
  constructor(code = 'wechat_tool_not_ready') { super('微信读取工具尚不可用。'); this.code = code; }
}
export interface SetupGrant { mode: 'selected' | 'all_private'; historyAuthorized: boolean }
export interface WechatSetupStore {
  read(ownerId: string): Promise<string | null>;
  connect(ownerId: string, accountId: string, at: Date, grant: SetupGrant, assertCurrent?: () => void, historySessions?: readonly HistorySession[]): Promise<void>;
}
export interface SetupResult { state: string; account_id: string | null; candidate_token: string | null; failure_code: string | null }
const result = (state: string, account: string | null = null, token: string | null = null, failure: string | null = null): SetupResult =>
  ({ state, account_id: account, candidate_token: token, failure_code: failure });
export class WechatSetupService {
  private candidate: { account: string; token: string } | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly options: { ownerId?: string; runtimeAccount?: string; store: WechatSetupStore;
    historySessions?: (account: string, signal?: AbortSignal) => Promise<readonly HistorySession[]>;
    probe: (signal?: AbortSignal) => Promise<string>; confirmProbe: (account: string, signal?: AbortSignal) => Promise<string>; clock?: () => Date; closeProbe?: () => Promise<void> };
  constructor(options: WechatSetupService['options']) { this.options = options; }
  private assertOpen(): void { if (this.closed) throw new HostStorageError('runtime_stopping'); }
  private async existing(): Promise<SetupResult | undefined> {
    if (!this.options.ownerId) return result('needs_owner');
    const account = await this.options.store.read(this.options.ownerId);
    if (!account) return undefined;
    if (this.options.runtimeAccount && this.options.runtimeAccount !== account) throw new WechatSetupConflict();
    return result(this.options.runtimeAccount === account ? 'connected' : 'restart_required', account);
  }
  private run(operation: (assertCurrent: () => void) => Promise<SetupResult>, externalAssert: () => void = () => {}): Promise<SetupResult> {
    const pending = this.tail.then(async () => {
      const assertCurrent = () => { this.assertOpen(); externalAssert(); };
      assertCurrent();
      try { const value = await operation(assertCurrent); assertCurrent(); return value; }
      catch (error) {
        if (error instanceof WechatSetupConflict) return result('conflict', null, null, 'wechat_identity_conflict');
        if (error instanceof WechatProbeUnavailable) {
          this.candidate = undefined;
          const code = ['wechat_tool_unavailable', 'wechat_tool_not_ready', 'wechat_account_changed'].includes(error.code) ? error.code : 'wechat_probe_failed';
          return result(code === 'wechat_account_changed' ? 'conflict' : code === 'wechat_tool_unavailable' ? 'tool_unavailable' : 'tool_not_ready', null, null, code);
        }
        throw error;
      }
    });
    this.tail = pending.catch(() => {});
    return pending;
  }
  status(assertCurrent?: () => void): Promise<SetupResult> { return this.run(async () => await this.existing() ?? result('needs_detection'), assertCurrent); }
  detect(assertCurrent?: () => void, signal?: AbortSignal): Promise<SetupResult> {
    return this.run(async current => {
      const existing = await this.existing(); if (existing) return existing;
      const account = await this.options.probe(signal); current();
      if (!/^[A-Za-z0-9_.@-]{1,255}$/.test(account)) throw new WechatProbeUnavailable('wechat_probe_failed');
      if (this.candidate?.account !== account) this.candidate = { account, token: randomBytes(32).toString('base64url') };
      return result('ready', account, this.candidate!.token);
    }, assertCurrent);
  }
  confirm(input: { candidate_token: string; mode?: 'selected' | 'all_private'; historyAuthorized?: boolean }, assertCurrent?: () => void, signal?: AbortSignal): Promise<SetupResult> {
    return this.run(async current => {
      const existing = await this.existing(); if (existing) return existing;
      if (input.mode !== undefined && !['selected','all_private'].includes(input.mode) || input.historyAuthorized !== undefined && typeof input.historyAuthorized !== 'boolean') throw new HostStorageError('setup_request_invalid');
      const token = typeof input.candidate_token === 'string' && input.candidate_token.length <= 128 ? Buffer.from(input.candidate_token) : Buffer.alloc(0);
      const expected = Buffer.from(this.candidate?.token ?? '');
      if (!this.candidate || token.length !== expected.length || !timingSafeEqual(token, expected)) return result('conflict', null, null, 'wechat_candidate_expired');
      const account = await this.options.probe(signal); current();
      if (account !== this.candidate.account) { this.candidate = undefined; return result('conflict', null, null, 'wechat_account_changed'); }
      if (await this.options.confirmProbe(account, signal) !== account) { this.candidate = undefined; return result('conflict', null, null, 'wechat_account_changed'); }
      current();
      let historySessions: readonly HistorySession[] | undefined;
      if (input.mode === 'all_private' && input.historyAuthorized) {
        if (!this.options.historySessions) throw new WechatProbeUnavailable();
        historySessions = await this.options.historySessions(account, signal); current();
        if (await this.options.probe(signal) !== account) { this.candidate = undefined; return result('conflict', null, null, 'wechat_account_changed'); }
        current();
      }
      await this.options.store.connect(this.options.ownerId!, account, this.options.clock?.() ?? new Date(), { mode: input.mode ?? 'selected', historyAuthorized: input.historyAuthorized ?? false }, current, historySessions);
      return result('restart_required', account);
    }, assertCurrent);
  }
  async close(): Promise<void> { this.closed = true; this.candidate = undefined; await this.options.closeProbe?.(); await this.tail; }
}

/** 沿用原表、UUID 与领域锁；领域错误在事务内转换，避免宿主抹去冲突类型。 */
export class PostgresWechatSetupStore implements WechatSetupStore {
  private readonly storage: Pick<HostStorage, 'businessTransaction'>;
  constructor(storage: Pick<HostStorage, 'businessTransaction'>) { this.storage = storage; }
  read(ownerId: string): Promise<string | null> {
    return this.storage.businessTransaction(async client => {
      const { rows } = await client.query("SELECT external_id,status FROM public.owner_channel_identity WHERE owner_id=$1 AND channel='wechat'", [ownerId]);
      if (!rows.length) return null;
      if (rows.length !== 1 || rows[0].status !== 'active') throw new WechatSetupConflict();
      return rows[0].external_id;
    });
  }
  connect(ownerId: string, accountId: string, at: Date, grant: SetupGrant, assertCurrent: () => void = () => {}, historySessions?: readonly HistorySession[]): Promise<void> {
    if (!/^[A-Za-z0-9_.@-]{1,255}$/.test(accountId) || !Number.isFinite(at.getTime()) || !['selected','all_private'].includes(grant.mode) || typeof grant.historyAuthorized !== 'boolean') throw new HostStorageError('setup_request_invalid');
    assertCurrent();
    return this.storage.businessTransaction(async client => {
      try {
        assertCurrent();
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`owner:${ownerId}`]);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`wechat-setup-account:${accountId}`]);
        const { rows } = await client.query("SELECT owner_id,external_id,status FROM public.owner_channel_identity WHERE channel='wechat' AND (owner_id=$1 OR external_id=$2) FOR UPDATE", [ownerId, accountId]);
        if (rows.length) {
          if (rows.length === 1 && rows[0].owner_id === ownerId && rows[0].external_id === accountId && rows[0].status === 'active') return;
          throw new WechatSetupConflict();
        }
        await client.query("INSERT INTO public.owner_channel_identity(owner_id,channel,external_id,observed_name,verified_at) VALUES($1,'wechat',$2,$2,$3)", [ownerId, accountId, at]);
        await client.query("INSERT INTO public.wechat_sync_scope(owner_id,channel,account_scope,mode,granted_at) VALUES($1,'wechat',$2,$3,$4)", [ownerId, accountId, grant.mode, at]);
        if (grant.historyAuthorized && grant.mode === 'all_private') await client.query("INSERT INTO public.wechat_history_sync_authorization(owner_id,channel,account_scope,version,decision,decided_at) VALUES($1,'wechat',$2,1,'accepted',$3)", [ownerId, accountId, at]);
        await client.query('INSERT INTO public.front_sync_state(owner_id,enabled,enabled_at) VALUES($1,true,$2) ON CONFLICT(owner_id) DO UPDATE SET enabled=true,enabled_at=EXCLUDED.enabled_at,updated_at=now()', [ownerId, at]);
        if (grant.historyAuthorized && grant.mode === 'all_private') await enrollHistorySnapshot(client, ownerId, accountId, historySessions, at, assertCurrent);
        assertCurrent();
      } catch (error) {
        if (['23505','wechat_identity_conflict'].includes((error as {code?: string}).code ?? '')) throw new WechatSetupConflict();
        throw error;
      }
    });
  }
}
