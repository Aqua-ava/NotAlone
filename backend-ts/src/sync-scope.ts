/** 账号级范围与历史决定只由明确用户操作改变；新绑定授权按已接受决定在同一范围事务派生。 */
import type pg from 'pg';
import { createHash } from 'node:crypto';
import { grantBindingHistory, authorizedHistoryBindings } from './sync-scope-history.ts';
import { HostStorage, HostStorageError } from './host-storage.ts';

export class SyncScopeError extends HostStorageError {
  readonly status: number;
  constructor(code: string, status = 409) { super(code); this.status = status; }
}
export interface SyncScopeOptions {
  storage: HostStorage;
  ownerId: string;
  accountScope: string;
  channel?: string;
  clock?: () => Date;
}
export interface SyncScopeState { mode: 'selected' | 'all_private'; granted_at: string | null; enabled: boolean }
export class SyncScopeService {
  private readonly options: SyncScopeOptions;
  private closed = false;
  constructor(options: SyncScopeOptions) { this.options = options; }
  close(): void { this.closed = true; }
  private current(assertCurrent: () => void): void {
    if (this.closed) throw new SyncScopeError('runtime_stopping',503);
    assertCurrent();
  }
  private async transaction<T>(operation: (client: pg.Client) => Promise<T>, assertCurrent: () => void): Promise<T> {
    this.current(assertCurrent);
    const {storage,ownerId,accountScope,channel = 'wechat'} = this.options;
    return storage.businessTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${ownerId}`]);
      const identities = (await client.query('SELECT external_id,status FROM public.owner_channel_identity WHERE owner_id=$1 AND channel=$2 FOR SHARE',[ownerId,channel])).rows;
      if (identities.length !== 1 || identities[0].status !== 'active' || identities[0].external_id !== accountScope)
        throw new SyncScopeError('wechat_identity_conflict');
      const result = await operation(client);
      this.current(assertCurrent);
      return result;
    });
  }
  private async state(client: pg.Client): Promise<SyncScopeState> {
    const {ownerId,accountScope,channel = 'wechat'} = this.options;
    const row = (await client.query(`SELECT s.mode,s.granted_at,coalesce(f.enabled,false) AS enabled
      FROM public.owner o LEFT JOIN public.wechat_sync_scope s ON s.owner_id=o.id AND s.channel=$2 AND s.account_scope=$3
      LEFT JOIN public.front_sync_state f ON f.owner_id=o.id WHERE o.id=$1`,[ownerId,channel,accountScope])).rows[0];
    if (!row) throw new SyncScopeError('owner_uninitialized',503);
    return {mode:row.mode ?? 'selected',granted_at:row.granted_at?.toISOString() ?? null,enabled:row.enabled};
  }
  read(assertCurrent: () => void = () => {}): Promise<SyncScopeState> { return this.transaction(client => this.state(client),assertCurrent); }
  async setMode(body: unknown, assertCurrent: () => void = () => {}): Promise<SyncScopeState> {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'confirmed,mode'
      || (body as {confirmed?: unknown}).confirmed !== true || !['selected','all_private'].includes((body as {mode: string}).mode))
      throw new SyncScopeError('invalid_sync_scope',400);
    const mode = (body as {mode: string}).mode;
    const {ownerId,accountScope,channel = 'wechat'} = this.options;
    return this.transaction(async client => {
      const at = (this.options.clock ?? (() => new Date()))();
      await client.query(`INSERT INTO public.wechat_sync_scope(owner_id,channel,account_scope,mode,granted_at)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,channel,account_scope) DO UPDATE SET mode=EXCLUDED.mode,updated_at=now(),
        granted_at=CASE WHEN wechat_sync_scope.mode='all_private' AND EXCLUDED.mode='all_private'
        THEN wechat_sync_scope.granted_at ELSE EXCLUDED.granted_at END`,[ownerId,channel,accountScope,mode,mode === 'all_private' ? at : null]);
      return this.state(client);
    },assertCurrent);
  }
  private async history(client: pg.Client): Promise<{state: 'required' | 'accepted' | 'declined'; version: number | null; current_version: number}> {
    const {ownerId,accountScope,channel = 'wechat'} = this.options;
    const row = (await client.query('SELECT version,decision FROM public.wechat_history_sync_authorization WHERE owner_id=$1 AND channel=$2 AND account_scope=$3',[ownerId,channel,accountScope])).rows[0];
    // 未知未来版本不得当作本版本已理解的授权，也不覆盖原决定。
    return {state:row?.version === 1 ? row.decision : 'required',version:row?.version ?? null,current_version:1};
  }
  historyAuthorization(assertCurrent: () => void = () => {}) { return this.transaction(client => this.history(client),assertCurrent); }
  async decideHistory(body: unknown, assertCurrent: () => void = () => {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'confirmed,decision'
      || (body as {confirmed?:unknown}).confirmed !== true || !['accepted','declined'].includes((body as {decision:string}).decision))
      throw new SyncScopeError('invalid_history_authorization',400);
    const {ownerId,accountScope,channel = 'wechat'} = this.options;
    return this.transaction(async client => {
      const previous = await this.history(client);
      await client.query(`INSERT INTO public.wechat_history_sync_authorization(owner_id,channel,account_scope,version,decision,decided_at)
        VALUES($1,$2,$3,1,$4,$5) ON CONFLICT(owner_id,channel,account_scope) DO UPDATE SET
        version=EXCLUDED.version,decision=EXCLUDED.decision,
        decided_at=CASE WHEN wechat_history_sync_authorization.decision='accepted' AND wechat_history_sync_authorization.version=EXCLUDED.version
          THEN wechat_history_sync_authorization.decided_at ELSE EXCLUDED.decided_at END,updated_at=now()
        WHERE (EXCLUDED.decision='accepted' AND wechat_history_sync_authorization.version<=EXCLUDED.version)
          OR (EXCLUDED.decision='declined' AND wechat_history_sync_authorization.version<EXCLUDED.version)`,
        [ownerId,channel,accountScope,(body as {decision:string}).decision,(this.options.clock ?? (() => new Date()))()]);
      if ((body as {decision:string}).decision === 'accepted' && previous.state !== 'accepted') {
        const history = await this.history(client);
        if (history.state === 'accepted') await grantBindingHistory(client,this.options,undefined,(this.options.clock ?? (() => new Date()))());
      }
      return this.history(client);
    },assertCurrent);
  }

  historyBindings(assertCurrent: () => void = () => {}): Promise<string[]> {
    return this.transaction(client => authorizedHistoryBindings(client,this.options),assertCurrent);
  }
  /** 调度器须先检查canDiscover再读取列表；事务内再核对开关和范围。 */
  async canDiscover(assertCurrent: () => void = () => {}): Promise<boolean> {
    const state = await this.read(assertCurrent);
    return state.enabled && state.mode === 'all_private';
  }
  async enroll(sessions: readonly {username:string;display_name:string;chat_type:string}[], assertCurrent: () => void = () => {}): Promise<{created:number;conflicts:string[]}> {
    if (!Array.isArray(sessions) || sessions.length > 5000) throw new SyncScopeError('cli_sessions_invalid',400);
    const seen = new Set<string>();
    for (const item of sessions) {
      if (!item || typeof item.username !== 'string' || !item.username.trim() || item.username.length > 255
        || typeof item.display_name !== 'string' || item.display_name.length > 4096 || typeof item.chat_type !== 'string'
        || seen.has(item.username)) throw new SyncScopeError('cli_sessions_invalid',400);
      seen.add(item.username);
    }
    const {ownerId,accountScope,channel = 'wechat'} = this.options;
    return this.transaction(async client => {
      const state = await this.state(client);
      if (!state.enabled || state.mode !== 'all_private') return {created:0,conflicts:[]};
      const history = await this.history(client);
      // version 2 等在 history() 中降为 required，不能借旧决定静默扩权。
      const grantNewHistory = history.state === 'accepted' && history.version === 1;
      const known = new Set((await client.query('SELECT conversation_locator FROM public.conversation_binding WHERE owner_id=$1 AND channel=$2 AND account_scope=$3',[ownerId,channel,accountScope])).rows.map(row => row.conversation_locator));
      const excluded = new Set((await client.query('SELECT locator_hash FROM public.wechat_sync_exclusion WHERE owner_id=$1 AND channel=$2 AND account_scope=$3',[ownerId,channel,accountScope])).rows.map(row => (row.locator_hash as Buffer).toString('hex')));
      const identities = (await client.query('SELECT external_id,contact_id,status FROM public.channel_identity WHERE owner_id=$1 AND channel=$2 AND external_id=ANY($3)',[ownerId,channel,sessions.map(s => s.username)])).rows;
      let created = 0;
      const conflicts: string[] = [];
      const started = performance.now();
      for (const session of sessions) {
        this.current(assertCurrent);
        if (created >= 250 || performance.now() - started >= 2000) break;
        if (session.chat_type !== 'private' || known.has(session.username) || excluded.has(createHash('sha256').update(session.username).digest('hex'))) continue;
        const matches = identities.filter(row => row.external_id === session.username);
        const active = new Set<string>(matches.filter(row => row.status === 'active').map(row => row.contact_id));
        if (active.size > 1) {conflicts.push(session.username);continue;}
        if (matches.length && !active.size) continue;
        const name = session.display_name || session.username;
        const contact = active.size ? [...active][0] : (await client.query('INSERT INTO public.contact(owner_id,display_name) VALUES($1,$2) RETURNING id',[ownerId,name])).rows[0].id;
        const binding = (await client.query(`INSERT INTO public.conversation_binding(owner_id,contact_id,channel,account_scope,conversation_locator,display_name)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[ownerId,contact,channel,accountScope,session.username,name])).rows[0].id;
        const enrolledAt=(this.options.clock ?? (() => new Date()))();
        await client.query(`INSERT INTO public.wechat_observation_baseline(owner_id,contact_id,binding_id,conversation_locator,baseline_at)
          VALUES($1,$2,$3,$4,$5)`,[ownerId,contact,binding,session.username,enrolledAt]);
        // ADR-100：已接受的账号级全部私聊授权覆盖此后首次进入范围的新私聊；
        // selected、declined、required、未知版本和排除项都已在前面单独阻断。
        if (grantNewHistory && await grantBindingHistory(client,this.options,[binding],enrolledAt) !== 1)
          throw new SyncScopeError('history_binding_authorization_failed',500);
        known.add(session.username);created++;
      }
      return {created,conflicts};
    },assertCurrent);
  }

}
