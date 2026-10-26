/** HTTP 业务适配；不持有 DSH 会话，不读取正文，不管理共享存储生命周期。 */
import { parseWechatScopeJson } from './wechat-scope-json.ts';
import { HostStorageError, type HostStorage } from '../platform/database/host-storage.ts';
import { PostgresWechatSetupStore, WechatSetupService, WechatSetupConflict } from './wechat-setup.ts';
import { WechatSetupProbe } from './wechat-setup-probe.ts';
import { WechatSessions } from './wechat-sessions.ts';
import { BindingService, type SavedBinding, type BindingSelection } from '../contacts/binding-service.ts';
import { SyncScopeService, SyncScopeError } from './sync-scope.ts';

const routes = new Map([
  ['/api/setup/wechat','GET'], ['/api/setup/wechat/detect','POST'], ['/api/setup/wechat/confirm','POST'],
  ['/api/sync/cli-sessions','GET'], ['/api/sync/cli-bindings','GET'], ['/api/sync/cli-bindings/confirm','POST'],
  ['/api/sync/cli-bindings/revoke','POST'], ['/api/sync/scope','POST'], ['/api/sync/history-authorization','POST'],
  ['/api/runtime/wechat-scope/history-state','POST'], ['/api/runtime/wechat-scope/history-bindings','POST'], ['/api/runtime/wechat-scope/revoke','POST'], ['/api/runtime/wechat-scope/state','POST'], ['/api/runtime/wechat-scope/discover','POST'],
]);
export function isWechatScopeRoute(path: string): boolean { return routes.has(path); }
export function wechatScopeBodyLimit(_path: string): number { return 1024 * 1024; }
export interface WechatScopeResponse { status: number; body: unknown }
const response = (body: unknown, status = 200): WechatScopeResponse => ({status,body});
const invalid = (code: string): never => { throw new SyncScopeError(code,400); };
function object(body: unknown, code: string): Record<string, unknown> {
  try {
    if (typeof body === 'string' || Buffer.isBuffer(body)) body = parseWechatScopeJson(body);
  } catch { return invalid(code); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid(code);
  return body as Record<string, unknown>;
}
function exact(body: Record<string, unknown>, keys: string[], code: string): void {
  if (Object.keys(body).sort().join(',') !== keys.sort().join(',')) invalid(code);
}
function bindingPayload(row: SavedBinding) {
  return {binding_id:row.binding_id,contact_id:row.contact_id,conversation_locator:row.conversation_locator,display_name:row.display_name,status:row.status};
}
export async function createWechatScopeApi(options: {storage: HostStorage; executable: string; environment?: NodeJS.ProcessEnv; readSyncStatus: () => Promise<Record<string,unknown>>; revokeWithDrain?: (body: {contact_id:string;binding_id:string},signal:AbortSignal) => Promise<WechatScopeResponse>}) {
  const owner = options.storage.runtimeOwnerId;
  const store = new PostgresWechatSetupStore(options.storage);
  // 账号固定在启动期；新确认要求重启，不能静默跨账号复用服务。
  let account: string | null = null;
  try { account = owner ? await store.read(owner) : null; }
  catch (error) { if (!(error instanceof WechatSetupConflict)) throw error; }
  const probe = new WechatSetupProbe(options);
  const sessions = new WechatSessions(options);
  const setup = new WechatSetupService({ownerId:owner,runtimeAccount:account ?? undefined,store,probe:signal => probe.detect(signal),confirmProbe:(a,signal) => probe.confirm(a,signal),historySessions:(account,signal) => sessions.sessions({type_filter:'private',limit:5000,expected_account:account,signal}),closeProbe:() => probe.close()});
  const stopping = new AbortController();
  let closed = false;
  const pending = new Set<Promise<WechatScopeResponse>>();
  const scope = owner && account ? new SyncScopeService({storage:options.storage,ownerId:owner,accountScope:account}) : undefined;
  const binding = owner && account ? new BindingService({storage:options.storage,ownerId:owner,channel:'wechat',accountScope:account,
    sessions:args => sessions.sessions({...args,expected_account:account}),assertCurrent:() => {if (closed) throw new HostStorageError('runtime_stopping');}}) : undefined;
  async function state(check: () => void) {
    const current = await scope!.read(check);
    const history = await scope!.historyAuthorization(check);
    return {sync_scope:current.mode,sync_scope_failure_code:null,enabled:current.enabled,
      cli_history_authorization_state:history.state,cli_history_authorization_version:history.version,cli_history_authorization_current_version:history.current_version};
  }
  async function publicStatus(check: () => void) {
    const legacy = await options.readSyncStatus(); check();
    return {...legacy,...await state(check)};
  }
  async function execute(method: string,path: string,raw: unknown,assertCurrent: () => void,signal: AbortSignal): Promise<WechatScopeResponse> {
    const check = () => {if (closed || signal.aborted) throw new HostStorageError('runtime_stopping'); assertCurrent();};
    try {
      check();
      if (routes.get(path) !== method) return response({error:'not_found'},404);
      const setupRoute = path.startsWith('/api/setup/');
      const code = setupRoute ? 'setup_request_invalid' : path.endsWith('/scope') ? 'invalid_sync_scope' : path.endsWith('/history-authorization') ? 'invalid_history_authorization' : path.endsWith('/revoke') ? 'cli_binding_revoke_invalid' : 'cli_binding_request_invalid';
      if ((typeof raw === 'string' || Buffer.isBuffer(raw)) && Buffer.byteLength(raw) > wechatScopeBodyLimit(path)) return response({error:'request_body_too_large'},413);
      const body = method === 'POST' ? object(raw,code) : {};
      if (setupRoute) {
        let result;
        if (path === '/api/setup/wechat') result = await setup.status(check);
        else if (path.endsWith('/detect')) {exact(body,[],code); result = await setup.detect(check,signal);}
        else {
          if (Object.keys(body).some(k => !['candidate_token','confirmed','mode','history_authorized'].includes(k)) || body.confirmed !== true
            || typeof body.candidate_token !== 'string' || !/^[\x00-\x7f]{1,128}$/.test(body.candidate_token)
            || body.mode !== undefined && !['selected','all_private'].includes(body.mode as string)
            || body.history_authorized !== undefined && typeof body.history_authorized !== 'boolean') invalid(code);
          result = await setup.confirm({candidate_token:body.candidate_token as string,mode:body.mode as 'selected'|'all_private'|undefined,historyAuthorized:body.history_authorized as boolean|undefined},check,signal);
        }
        check(); return response(result);
      }
      if (!scope || !binding) return response({error:'sync_unavailable'},503);
      let result: unknown;
      if (path.startsWith('/api/runtime/')) {
        exact(body,path.endsWith('/revoke') ? ['owner_id','channel','account_scope','contact_id','binding_id'] : ['owner_id','channel','account_scope'],'wechat_scope_request_invalid');
        if (body.owner_id !== owner || body.channel !== 'wechat' || body.account_scope !== account) return response({error:'wechat_scope_mismatch'},409);
        if (path.endsWith('/revoke')) result = bindingPayload(await binding.revoke(body.contact_id as string,body.binding_id as string,signal,check));
        else if (path.endsWith('/state')) result = await scope.read(check);
        else if (path.endsWith('/history-state')) result = await scope.historyAuthorization(check);
        else if (path.endsWith('/history-bindings')) result = {binding_ids:await scope.historyBindings(check)};
        else {
          result = {created:0,conflicts:[]};
          if (await scope.canDiscover(check)) {
            const candidates = await sessions.sessions({type_filter:'private',limit:5000,expected_account:account!,signal}); check();
            result = await scope.enroll(candidates,check);
          }
        }
      } else if (path.endsWith('/cli-sessions')) result = {sessions:await binding.candidates(signal,check)};
      else if (path.endsWith('/cli-bindings')) {
        const rows = await binding.list(true,signal,check);
        const revoked = rows.filter(r => r.status === 'revoked').map(bindingPayload);
        result = {bindings:rows.filter(r => r.status === 'active').map(bindingPayload),...(revoked.length ? {revoked_bindings:revoked} : {})};
      } else if (path.endsWith('/cli-bindings/confirm')) {
        if (!Object.hasOwn(body,'selections') || Object.keys(body).some(k => !['selections','history_authorized'].includes(k))
          || body.history_authorized !== undefined && typeof body.history_authorized !== 'boolean') invalid(code);
        if (!Array.isArray(body.selections) || body.selections.some(item => !item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(k => !['locator','contact_id','display_name','observed_display_name'].includes(k)))) invalid(code);
        await binding.confirm(body.selections as BindingSelection[],signal,check,body.history_authorized as boolean|undefined); check(); result = await publicStatus(check);
      } else if (path.endsWith('/revoke')) {
        exact(body,['contact_id','binding_id'],code);
        if (options.revokeWithDrain) {
          const drained = await options.revokeWithDrain({contact_id:body.contact_id as string,binding_id:body.binding_id as string},signal);
          check(); return drained;
        }
        result = bindingPayload(await binding.revoke(body.contact_id as string,body.binding_id as string,signal,check));
      } else if (path.endsWith('/scope')) {await scope.setMode(body,check); result = await publicStatus(check);}
      else {await scope.decideHistory(body,check); result = await publicStatus(check);}
      check(); return response(result);
    } catch (error) {
      const code = (error as {code?:string}).code;
      if (closed || signal.aborted || ['runtime_stopping','cli_cancelled','cli_binding_cancelled'].includes(code ?? '')) return response({error:'runtime_stopping'},503);
      if (code === 'cli_binding_revoke_busy') return response({error:code},409);
      if (error instanceof SyncScopeError) return response({error:error.code},error.status);
      if (code === 'cli_binding_conflict' || code === 'cli_binding_selection_stale') return response({error:'cli_binding_rejected',reason:code === 'cli_binding_conflict' ? 'binding_conflict' : 'selection_stale'},409);
      if (code === 'cli_binding_not_found') return response({error:code},404);
      if (code === 'cli_binding_request_invalid' || code === 'setup_request_invalid') return response({error:path.endsWith('/revoke') ? 'cli_binding_revoke_invalid' : code},400);
      if (['wechat_identity_conflict','cli_binding_account_changed','cli_account_changed','cli_identity_conflict'].includes(code ?? '')) return response({error:code},409);
      const fallback = path.startsWith('/api/setup/') ? 'setup_operation_failed' : path.endsWith('/cli-sessions') ? 'cli_sessions_failed' : path.endsWith('/cli-bindings') ? 'cli_bindings_failed' : path.endsWith('/revoke') ? 'cli_binding_revoke_failed' : path.endsWith('/scope') ? 'sync_scope_failed' : path.endsWith('/history-authorization') ? 'history_authorization_failed' : path.endsWith('/cli-bindings/confirm') ? 'cli_binding_failed' : 'wechat_scope_failed';
      return response({error:fallback},500);
    }
  }
  let closing: Promise<void> | undefined;
  return {
    async decorateSyncStatus(report: Record<string,unknown>,assertCurrent: () => void = () => {}) {
      const check=()=>{if(closed || !scope)throw new HostStorageError('runtime_stopping');assertCurrent();};
      check();
      const authority=await state(check);check();
      // 账号范围与历史决定由TS持有；进度、健康和运行失败原因仍来自原执行方。
      return {...report,sync_scope:authority.sync_scope,
        cli_history_authorization_state:authority.cli_history_authorization_state,
        cli_history_authorization_version:authority.cli_history_authorization_version,
        cli_history_authorization_current_version:authority.cli_history_authorization_current_version};
    },
    handle(method: string,path: string,body: unknown = {},assertCurrent: () => void = () => {},signal?: AbortSignal) {
      const combined = signal ? AbortSignal.any([signal,stopping.signal]) : stopping.signal;
      const work = execute(method,path,body,assertCurrent,combined);
      pending.add(work); void work.finally(() => pending.delete(work)); return work;
    },
    close(): Promise<void> {
      if (!closing) {
        closed = true; stopping.abort(); scope?.close();
        closing = (async () => {await Promise.all([sessions.close(),binding?.close(),setup.close()]); await Promise.allSettled([...pending]);})();
      }
      return closing;
    },
  };
}
