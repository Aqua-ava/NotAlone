/** 内部增量同步 HTTP 适配；认证由宿主完成，不注册模型工具或启动自主计时器。 */
import {HostStorageError,type HostStorage} from './host-storage.ts';
import {PostgresWechatSetupStore,WechatSetupConflict} from './wechat-setup.ts';
import {parseWechatScopeJson} from './wechat-scope-json.ts';
import {SyncScopeService} from './sync-scope.ts';
import {WechatSessions} from './wechat-sessions.ts';
import {SyncIncrementalCli} from './sync-incremental-cli.ts';
import {SyncIncrementalStore} from './sync-incremental-store.ts';
import {SyncIncrementalRecovery} from './sync-incremental-recovery.ts';
import {SyncIncrementalEngine} from './sync-incremental-engine.ts';
import {SyncHistory} from './sync-history.ts';

const prefix='/api/runtime/sync-incremental/';
const commands=new Set(['cycle','status','enable','disable','check','priority','pause','retry','stop','resume','follow-status','follow-enable','follow-disable','follow-interrupt']);
export function isSyncIncrementalRoute(path:string):boolean{return path.startsWith(prefix)&&commands.has(path.slice(prefix.length));}
export function syncIncrementalBodyLimit(_path?:string):number{return 16*1024;}
export interface SyncIncrementalResponse {status:number;body:unknown}
export interface IncrementalMessageCreated {owner_id:string;contact_id:string;message_id:string;occurred_at:string}
interface Options {storage:HostStorage;executable:string;environment?:NodeJS.ProcessEnv;publish:(events:readonly IncrementalMessageCreated[],signal:AbortSignal)=>Promise<void>;historyOwner?:'python'|'typescript';historyPageLimit?:number}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const response=(body:unknown,status=200):SyncIncrementalResponse=>({status,body});
export async function createSyncIncrementalApi(options:Options){
 const owner=options.storage.runtimeOwnerId;let account:string|null=null;
 try{account=owner?await new PostgresWechatSetupStore(options.storage).read(owner):null;}catch(error){if(!(error instanceof WechatSetupConflict))throw error;}
 const stopping=new AbortController();let closed=false;let closing:Promise<void>|undefined;
 const pending=new Set<Promise<SyncIncrementalResponse>>();
 const scope=owner&&account?new SyncScopeService({storage:options.storage,ownerId:owner,accountScope:account}):undefined;
 const sessions=scope?new WechatSessions(options):undefined;
 const cli=scope?new SyncIncrementalCli(options):undefined;
 const store=scope?new SyncIncrementalStore({storage:options.storage,ownerId:owner!,accountScope:account!}):undefined;
 const recovery=store?new SyncIncrementalRecovery({store,storage:options.storage,ownerId:owner!}):undefined;
 const history=store&&options.historyOwner==='typescript'?new SyncHistory({store,cli:cli!,accountScope:account!,pageLimit:options.historyPageLimit}):undefined;
 const engine=store?new SyncIncrementalEngine({ownerId:owner!,accountScope:account!,store,scope:scope!,sessions:sessions!,cli:cli!,recovery:recovery!,history,publish:options.publish}):undefined;
 async function runtimeStatus(check:()=>void=()=>{}):Promise<Record<string,unknown>>{
  if(!engine||!store)throw new HostStorageError('sync_unavailable');
  const enabled=await store.readEnabled(check);check();
  return {...engine.status(),enabled};
 }
 async function executeInternal(method:string,path:string,raw:unknown,assertCurrent:()=>void,signal:AbortSignal):Promise<SyncIncrementalResponse>{
  try{
   const check=()=>{if(closed||signal.aborted)throw new HostStorageError('runtime_stopping');assertCurrent();};check();
   if(method!=='POST'||!isSyncIncrementalRoute(path))return response({error:'not_found'},404);
   if(!engine)return response({error:'sync_unavailable'},503);
   if((typeof raw==='string'||Buffer.isBuffer(raw))&&Buffer.byteLength(raw)>syncIncrementalBodyLimit(path))return response({error:'request_body_too_large'},413);
   let value:unknown=raw;
   if(typeof value==='string'||Buffer.isBuffer(value)){try{value=parseWechatScopeJson(value);}catch{return response({error:'sync_incremental_request_invalid'},400);}}
   if(!value||typeof value!=='object'||Array.isArray(value))return response({error:'sync_incremental_request_invalid'},400);
   const body=value as Record<string,unknown>,command=path.slice(prefix.length);
   const base=['owner_id','channel','account_scope'];
   const allowed=[...base,...(command==='cycle'?['max_bindings','priority_contact_id','priority_requested_at']:command==='priority'?['priority_contact_id','priority_requested_at']:[])];
   if(base.some(key=>!Object.hasOwn(body,key))||Object.keys(body).some(key=>!allowed.includes(key)))return response({error:'sync_incremental_request_invalid'},400);
   if(body.owner_id!==owner||body.channel!=='wechat'||body.account_scope!==account)return response({error:'sync_scope_mismatch'},409);
   const hasPriority=Object.hasOwn(body,'priority_contact_id');
   if(command==='priority'&&!hasPriority||Object.hasOwn(body,'priority_requested_at')&&!hasPriority
     ||hasPriority&&body.priority_contact_id!==null&&(typeof body.priority_contact_id!=='string'||!uuid.test(body.priority_contact_id))
     ||body.priority_requested_at!==undefined&&body.priority_requested_at!==null&&(typeof body.priority_requested_at!=='number'||!Number.isFinite(body.priority_requested_at)||body.priority_requested_at<0)
     ||Object.hasOwn(body,'max_bindings')&&(typeof body.max_bindings!=='number'||!Number.isInteger(body.max_bindings)||body.max_bindings<1||body.max_bindings>32))return response({error:'sync_incremental_request_invalid'},400);
   if(hasPriority)engine.setPriority(typeof body.priority_contact_id==='string'?body.priority_contact_id.toLowerCase():null,body.priority_requested_at as number|null|undefined);
   check();
   if(command==='cycle')await engine.cycle({maxBindings:body.max_bindings as number|undefined??1,signal,assertCurrent:check});
   else if(command==='enable'||command==='disable')await engine.setEnabled(command==='enable',{maxBindings:1,signal,assertCurrent:check});
   else if(command==='check'||command==='retry')engine.requestCheck();
   else if(command==='stop')await engine.invalidateAndDrain('runtime_request');
   else if(command==='resume')engine.resume();
   else if(command==='pause')await engine.pauseBackfill({signal,assertCurrent:check});
   else if(command==='follow-enable'||command==='follow-disable')engine.setFollowEnabled(command==='follow-enable');
   else if(command==='follow-interrupt')await engine.interruptFollow();
   check();
   return response(command.startsWith('follow-')?engine.followStatus():await runtimeStatus(check));
  }catch(error){
   const code=(error as {code?:string})?.code;
   if(closed||signal.aborted||['runtime_stopping','cli_cancelled'].includes(code??''))return response({error:'runtime_stopping'},503);
   if(['cli_account_changed','wechat_identity_conflict','sync_scope_invalid','sync_binding_invalid','cli_follow_inactive'].includes(code??''))return response({error:code},409);
   return response({error:'sync_incremental_failed'},500);
  }
 }
 function execute(method:string,path:string,raw:unknown={},assertCurrent:()=>void=()=>{},signal?:AbortSignal):Promise<SyncIncrementalResponse>{
  const combined=signal?AbortSignal.any([signal,stopping.signal]):stopping.signal;
  const work=executeInternal(method,path,raw,assertCurrent,combined);pending.add(work);void work.finally(()=>pending.delete(work));return work;
 }
 return {execute,handle:execute,
  async status(assertCurrent:()=>void=()=>{}):Promise<Record<string,unknown>>{
   const check=()=>{if(closed||stopping.signal.aborted)throw new HostStorageError('runtime_stopping');assertCurrent();};
   check();return runtimeStatus(check);
  },
  async invalidateAndDrain(reason:string){return await engine?.invalidateAndDrain(reason);},
  resume(expectedVersion?:number){return !closed&&engine?.resume(expectedVersion);},
  close():Promise<void>{if(!closing){closed=true;stopping.abort();scope?.close();closing=(async()=>{await engine?.close();await Promise.allSettled([...pending]);})();}return closing;},
 };
}
