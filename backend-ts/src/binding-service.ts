import { grantBindingHistory } from './sync-scope-history.ts';
import type pg from 'pg';
import { HostStorageError } from './host-storage.ts';

export class BindingError extends HostStorageError {}
export interface BindingStorage {
  businessTransaction<T>(operation: (client: pg.Client) => Promise<T>): Promise<T>;
}
export interface BindingSession {
  username: string; display_name: string; chat_type: string; last_timestamp?: number | null;
}
export interface BindingSelection {
  locator: string; contact_id?: string | null; display_name?: string | null; observed_display_name?: string | null;
}
export interface SavedBinding {
  binding_id: string; owner_id: string; contact_id: string; channel: string; account_scope: string;
  conversation_locator: string; display_name: string | null; status: 'active' | 'revoked';
}
export interface BindingOptions {
  storage: BindingStorage; ownerId: string; channel: string; accountScope: string;
  sessions(options: {type_filter: 'private'; limit: number; signal?: AbortSignal}): Promise<readonly BindingSession[]>;
  clock?: () => Date;
  assertCurrent?: () => void;
}
const columns = 'id AS binding_id, owner_id, contact_id, channel, account_scope, conversation_locator, display_name, status';
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();

/** 普通业务模块：只消费会话元数据；不读取正文或创建 CLI/DSH 宿主。 */
export class BindingService {
  private readonly options: BindingOptions;
  private epoch = 0;
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(options: BindingOptions) {
    if (!uuid(options.ownerId) || options.channel !== 'wechat' || !nonempty(options.accountScope)) throw new BindingError('cli_binding_request_invalid');
    this.options = {...options, ownerId:options.ownerId.toLowerCase()};
  }
  /** 总开关、账号或授权改变时同步使在途结果失效；关闭后等待事务回滚。 */
  invalidate(): void { this.epoch++; }
  async close(): Promise<void> { this.closed = true; this.invalidate(); await Promise.allSettled([...this.pending]); }
  private run<T>(signal: AbortSignal | undefined, operation: (check: () => void) => Promise<T>, assertCurrent: () => void = () => {}): Promise<T> {
    const epoch = this.epoch;
    const check = () => {
      if (this.closed || epoch !== this.epoch || signal?.aborted) throw new BindingError('cli_binding_cancelled');
      this.options.assertCurrent?.(); assertCurrent();
    };
    const promise = Promise.resolve().then(() => { check(); return operation(check); });
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }
  private scope(): string[] { return [this.options.ownerId, this.options.channel, this.options.accountScope]; }
  private async requireAccount(client: pg.Client): Promise<void> {
    // 行共享锁把账号撤销/改绑与本事务串行化，不只依赖此前 CLI 元数据。
    const identities = await client.query("SELECT external_id FROM public.owner_channel_identity WHERE owner_id=$1 AND channel=$2 AND status='active' FOR SHARE",[this.options.ownerId,this.options.channel]);
    if (identities.rows.length !== 1 || identities.rows[0].external_id !== this.options.accountScope) throw new BindingError('cli_binding_account_changed');
  }
  private async sessions(signal: AbortSignal | undefined, check: () => void): Promise<BindingSession[]> {
    const rows = await this.options.sessions({type_filter:'private', limit:5000, signal});
    check();
    if (!Array.isArray(rows) || rows.length > 5000) throw new BindingError('cli_binding_metadata_invalid');
    const seen = new Set<string>();
    return rows.filter(row => row.chat_type === 'private').map(row => {
      if (!nonempty(row.username) || !nonempty(row.display_name) || seen.has(row.username)) throw new BindingError('cli_binding_selection_stale');
      seen.add(row.username); return row;
    });
  }
  list(includeRevoked = false, signal?: AbortSignal, assertCurrent: () => void = () => {}): Promise<SavedBinding[]> {
    return this.run(signal, check => this.options.storage.businessTransaction(async client => {
      await this.requireAccount(client);
      const rows = await client.query(`SELECT ${columns} FROM public.conversation_binding WHERE owner_id=$1 AND channel=$2 AND account_scope=$3 ${includeRevoked ? '' : "AND status='active'"} ORDER BY created_at,id`, this.scope());
      check(); return rows.rows;
    }), assertCurrent);
  }
  candidates(signal?: AbortSignal, assertCurrent: () => void = () => {}) {
    return this.run(signal, async check => {
      const sessions = await this.sessions(signal, check);
      const saved = await this.list(false, signal, assertCurrent); check();
      const active = new Map(saved.map(row => [row.conversation_locator, row.contact_id]));
      return sessions.map(row => ({username:row.username, display_name:row.display_name, last_timestamp:row.last_timestamp ?? null, bound_contact_id:active.get(row.username) ?? null}));
    }, assertCurrent);
  }
  confirm(selections: readonly BindingSelection[], signal?: AbortSignal, assertCurrent: () => void = () => {}, historyAuthorized = false): Promise<SavedBinding[]> {
    return this.run(signal, async check => {
      if (typeof historyAuthorized !== 'boolean') throw new BindingError('cli_binding_request_invalid');
      if (!Array.isArray(selections) || selections.length > 5000) throw new BindingError('cli_binding_request_invalid');
      const seen = new Set<string>();
      const normalized = selections.map(item => {
        if (!item || !nonempty(item.locator) || seen.has(item.locator.trim()) || item.contact_id != null && !uuid(item.contact_id)
          || item.display_name != null && !nonempty(item.display_name) || item.observed_display_name != null && !nonempty(item.observed_display_name)) throw new BindingError('cli_binding_request_invalid');
        seen.add(item.locator.trim()); return {...item, locator:item.locator.trim()};
      });
      if (!normalized.length) return [];
      const sessions = new Map((await this.sessions(signal, check)).map(row => [row.username,row]));
      const at = (this.options.clock ?? (() => new Date()))();
      if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new BindingError('cli_binding_request_invalid');
      return this.options.storage.businessTransaction(async client => {
        // 与删除共用 contact -> owner 锁顺序；固定排序避免多联系人批次互锁。
        for (const contact of [...new Set(normalized.flatMap(row => row.contact_id ? [row.contact_id.toLowerCase()] : []))].sort()) {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${this.options.ownerId}:${contact}`]);
        }
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${this.options.ownerId}`]);
        await this.requireAccount(client);
        check();
        const existing = await client.query(`SELECT ${columns} FROM public.conversation_binding WHERE owner_id=$1 AND channel=$2 AND account_scope=$3 AND status='active'`,this.scope());
        const active = new Map<string,SavedBinding>(existing.rows.map(row => [row.conversation_locator,row]));
        const result: SavedBinding[] = [];
        const authorizedIds: string[] = [];
        for (const item of normalized) {
          check();
          const candidate = sessions.get(item.locator);
          if (!candidate || item.observed_display_name != null && item.observed_display_name !== candidate.display_name) throw new BindingError('cli_binding_selection_stale');
          const bound = active.get(item.locator);
          const identities = await client.query("SELECT contact_id FROM public.channel_identity WHERE owner_id=$1 AND channel=$2 AND external_id=$3 AND status='active'",[this.options.ownerId,this.options.channel,item.locator]);
          const expectedContact = item.contact_id?.toLowerCase() ?? bound?.contact_id;
          if (identities.rows.some(row => row.contact_id !== expectedContact)) throw new BindingError('cli_binding_conflict');
          if (bound) {
            if (item.contact_id && item.contact_id.toLowerCase() !== bound.contact_id) throw new BindingError('cli_binding_conflict');
            if (item.observed_display_name != null && !item.contact_id) throw new BindingError('cli_binding_selection_stale');
            authorizedIds.push(bound.binding_id);
            continue;
          }
          let contact = item.contact_id;
          const display = item.display_name?.trim() || candidate.display_name;
          if (contact) {
            if (!(await client.query('SELECT id FROM public.contact WHERE owner_id=$1 AND id=$2 FOR KEY SHARE',[this.options.ownerId,contact])).rowCount) throw new BindingError('cli_binding_not_found');
          } else contact = (await client.query('INSERT INTO public.contact(owner_id,display_name) VALUES($1,$2) RETURNING id',[this.options.ownerId,display])).rows[0].id;
          let binding: SavedBinding;
          try {
            binding = (await client.query(`INSERT INTO public.conversation_binding(owner_id,contact_id,channel,account_scope,conversation_locator,display_name) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${columns}`,[this.options.ownerId,contact,this.options.channel,this.options.accountScope,item.locator,display])).rows[0];
          } catch (error) {
            if ((error as {code?:string}).code === '23505') throw new BindingError('cli_binding_conflict');
            throw error;
          }
          await client.query('INSERT INTO public.wechat_observation_baseline(owner_id,contact_id,binding_id,conversation_locator,baseline_at) VALUES($1,$2,$3,$4,$5)',[this.options.ownerId,contact,binding.binding_id,item.locator,at]);
          result.push(binding); authorizedIds.push(binding.binding_id);
        }
        if (historyAuthorized) await grantBindingHistory(client, this.options, authorizedIds, at);
        check(); return result;
      });
    }, assertCurrent);
  }
  revoke(contactId: string, bindingId: string, signal?: AbortSignal, assertCurrent: () => void = () => {}): Promise<SavedBinding> {
    return this.run(signal, check => {
      if (!uuid(contactId) || !uuid(bindingId)) throw new BindingError('cli_binding_request_invalid');
      return this.options.storage.businessTransaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${this.options.ownerId}:${contactId.toLowerCase()}`]);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${this.options.ownerId}`]);
        await this.requireAccount(client);
        check();
        const rows = await client.query(`UPDATE public.conversation_binding SET status='revoked',revoked_at=COALESCE(revoked_at,now()),updated_at=now() WHERE owner_id=$1 AND channel=$2 AND account_scope=$3 AND contact_id=$4 AND id=$5 RETURNING ${columns}`,[...this.scope(),contactId,bindingId]);
        if (!rows.rowCount) throw new BindingError('cli_binding_not_found');
        check(); return rows.rows[0];
      });
    }, assertCurrent);
  }
}
