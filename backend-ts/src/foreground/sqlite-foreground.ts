import {randomUUID} from 'node:crypto';
import {ForegroundLocator,ForegroundLocationError,type ForegroundProbe,type ForegroundSession,type ForegroundObservation} from './foreground-location-locator.ts';
import {NativeForegroundProbe} from './foreground-location-probe.ts';
import {loadNarrowWechatOptions} from '../history/wechat/artifacts.ts';
import {NarrowWechatClient} from '../history/wechat/native-client.ts';

export interface ForegroundSnapshot {enabled:boolean;readEpoch:string;account:{id:string;key:string;sourceGeneration:string;revision:string}|null;bindings:{binding_id:string;contact_id:string;account_id:string;conversation_locator:string;display_name:string|null;status:'active';grant_id:string|null;selection_generation:string;identityGeneration:string;dataGeneration:string;barrierGeneration:string}[]}
export interface ForegroundBindingConfirmation {
 observationId:string;observedAt:string;contactId:string;bindingId:string;readEpoch:string;
 accountId:string;sourceGeneration:string;scopeRevision:string;grantId:string;selectionGeneration:string;dataGeneration:string;barrierGeneration:string;
}
/**
 * 前台独占只读元数据进程，不与后台正文同步共用租约。
 * 全量名单耗时随会话数线性增长（约 1.8ms/个，近 500 个会话约 1 秒），远超单轮观察预算。
 * 因此：已有缓存时每轮只用常驻进程复验实时账号（约十几毫秒）并直接返回缓存；
 * 名单由一次性的独立进程在后台刷新，刷新不排队阻塞复验，也不受观察期限取消。
 */
const sessionRefreshAfterMs=30_000,sessionMaxAgeMs=300_000,sessionRefreshGapMs=5_000,sessionReadTimeoutMs=15_000;
const sourceGuardRetryAttempts=2;
const sourceGuardTransientCodes=new Set(['history_source_unverified','history_source_changed']);
const scopeFailureCodes=new Set(['foreground_scope_unavailable','history_scope_changed','history_account_changed','history_source_changed']);
type SessionParams={limit:number;keyword?:string};
type SessionAccount=NonNullable<ForegroundSnapshot['account']>;
type SessionCache={key:string;account:SessionAccount;params:SessionParams;evidence:string;at:number;rows:ForegroundSession[]};
export class ForegroundSessionList {
 private client?:NarrowWechatClient;
 private closed=false;
 private lifetime=new AbortController();
 private readonly active=new Set<Promise<unknown>>();
 private cache?:SessionCache;
 private inflight?:{key:string;promise:Promise<ForegroundSession[]>};
 private lastRefreshAt=-Infinity;
 private readonly executable:string;
 private readonly refreshAfterMs:number;
 private readonly refreshGapMs:number;
 private readonly clock:()=>number;
 constructor(executable:string,options:{refreshAfterMs?:number;refreshGapMs?:number;clock?:()=>number}={}){
  this.executable=executable;this.refreshAfterMs=options.refreshAfterMs??sessionRefreshAfterMs;this.refreshGapMs=options.refreshGapMs??sessionRefreshGapMs;this.clock=options.clock??Date.now;
 }
 async sessions(account:SessionAccount,options:{signal:AbortSignal;timeoutMs:number;limit:number;keyword?:string}):Promise<ForegroundSession[]>{
  if(this.closed||options.signal.aborted)throw new ForegroundLocationError('foreground_observation_cancelled');
  const caller=AbortSignal.any([options.signal,AbortSignal.timeout(Math.max(1,Math.floor(options.timeoutMs)))]);
  const params:SessionParams={limit:options.limit,keyword:options.keyword},key=JSON.stringify([account.key,account.sourceGeneration,options.limit,options.keyword??null]);
  const cached=this.cache;
  if(cached?.key===key&&this.clock()-cached.at<sessionMaxAgeMs){
   const rows=await this.wait(this.verify(cached),caller,options.signal);
   if(this.clock()-cached.at>=this.refreshAfterMs)this.refreshInBackground();
   return rows;
  }
  return this.wait(this.refresh(account,key,params),caller,options.signal);
 }
 /** 名称在缓存中找不到时调用：名单可能已过期，尽快后台重读（有最小间隔，不阻塞当前观察）。 */
 requestRefresh():void{this.refreshInBackground();}
 private refreshInBackground():void{
  const cached=this.cache;
  if(this.closed||!cached||this.inflight||this.clock()-this.lastRefreshAt<this.refreshGapMs)return;
  this.refresh(cached.account,cached.key,cached.params).catch(()=>{});
 }
 /** 调用方到期只停止等待；读取继续完成并写入缓存，供下一轮复用。 */
 private wait<T>(work:Promise<T>,caller:AbortSignal,external:AbortSignal):Promise<T>{
  return new Promise<T>((resolve,reject)=>{
   const stop=()=>reject(new ForegroundLocationError(external.aborted||this.closed?'foreground_observation_cancelled':'observation_timeout'));
   if(caller.aborted)return stop();
   caller.addEventListener('abort',stop,{once:true});
   void work.then(resolve,reject).finally(()=>caller.removeEventListener('abort',stop));
  });
 }
 private track<T>(work:Promise<T>):Promise<T>{
  this.active.add(work);void work.then(()=>{},()=>{}).finally(()=>this.active.delete(work));
  return work;
 }
 /** 缓存期内逐轮复验实时账号证据；账号或来源变化立即丢弃旧名单与进程。 */
 private verify(cached:SessionCache):Promise<ForegroundSession[]>{
  const signal=AbortSignal.any([this.lifetime.signal,AbortSignal.timeout(sessionReadTimeoutMs)]);
  return this.track((async()=>{
   this.client??=new NarrowWechatClient(await loadNarrowWechatOptions(this.executable));
   const client=this.client;
   try{
    const live=await client.accountMetadata(signal);
    if(JSON.stringify(live)!==cached.evidence)throw new ForegroundLocationError('history_scope_changed');
    return cached.rows;
   }catch(error){
    if(this.cache===cached)this.cache=undefined;
    if(this.client===client)this.client=undefined;
    await client.close();throw error;
   }
  })());
 }
 /** 一次性独立进程读取全量名单，同一时刻只有一个读取；完成后写入缓存并退出进程。 */
 private refresh(account:SessionAccount,key:string,params:SessionParams):Promise<ForegroundSession[]>{
  const prior=this.inflight;
  if(prior?.key===key)return prior.promise;
  const run=()=>{
   this.lastRefreshAt=this.clock();
   const signal=AbortSignal.any([this.lifetime.signal,AbortSignal.timeout(sessionReadTimeoutMs)]);
   const readOnce=async():Promise<ForegroundSession[]>=>{
    const client=new NarrowWechatClient(await loadNarrowWechatOptions(this.executable));
    try{
     const before=await client.accountMetadata(signal);
     if(before.status!=='verified'||before.accountKey!==account.key||before.sourceGeneration!==account.sourceGeneration)throw new ForegroundLocationError('foreground_scope_unavailable');
     const sessions=await client.allSessionMetadata(before,{limit:params.limit,keyword:params.keyword},signal);
     if(sessions.length>=params.limit)throw new ForegroundLocationError('foreground_scope_unavailable');
     const rows:ForegroundSession[]=sessions.map(row=>({username:row.username,display_name:row.displayName,chat_type:row.kind}));
     const after=await client.accountMetadata(signal);
     if(JSON.stringify(before)!==JSON.stringify(after))throw new ForegroundLocationError('foreground_scope_unavailable');
     this.cache={key,account,params,evidence:JSON.stringify(before),at:this.clock(),rows};
     return rows;
    }catch(error){
     if(scopeFailureCodes.has((error as {code?:string}).code??''))this.cache=undefined;
     throw error;
    }finally{await client.close();}
   };
   // 微信持续写库时，来源守卫可能在建立瞬间被无关事件打断；换新进程重核验一次，每次仍做完整的前后账号核验。
   const work=(async()=>{
    for(let attempt=1;;attempt++){
     try{return await readOnce();}
     catch(error){
      const code=(error as {code?:string}).code??'';
      if(attempt>=sourceGuardRetryAttempts||!sourceGuardTransientCodes.has(code)||signal.aborted)throw error;
     }
    }
   })();
   const entry={key,promise:work};this.inflight=entry;
   void work.then(()=>{},()=>{}).finally(()=>{if(this.inflight===entry)this.inflight=undefined;});
   return this.track(work);
  };
  return prior?prior.promise.then(()=>{},()=>{}).then(run):run();
 }
 async reset(){this.cache=undefined;this.lifetime.abort();await Promise.allSettled([...this.active]);const old=this.client;this.client=undefined;await old?.close();if(!this.closed)this.lifetime=new AbortController();}
 async close(){this.closed=true;await this.reset();}
}

/** 每轮复核当前授权范围与绑定；变更、删除和关闭先排空已接受观察。 */
export class SqliteForeground {
 private locator?:ForegroundLocator;
 private locatorAccount?:string;
 private closed=false;
 private changing=0;
 private active?:Promise<ForegroundObservation>;
 private confirming?:Promise<{confirmed:true}>;
 private pendingConfirmation?:{snapshot:string;proof:ForegroundBindingConfirmation};
 private readonly options:{ownerId:string;probe:ForegroundProbe;snapshot:()=>Promise<ForegroundSnapshot>;sessions:(account:NonNullable<ForegroundSnapshot['account']>,options:{signal:AbortSignal;timeoutMs:number;limit:number;keyword?:string})=>Promise<ForegroundSession[]>;closeSessions:()=>Promise<void>;invalidateSessions?:()=>Promise<void>;confirmBinding?:(proof:ForegroundBindingConfirmation)=>Promise<void>;requestSessionRefresh?:()=>void};
 constructor(options:SqliteForeground['options']){this.options=options;}
 static create(ownerId:string,probePath:string,cliPath:string,snapshot:()=>Promise<ForegroundSnapshot>,confirmBinding?:(proof:ForegroundBindingConfirmation)=>Promise<void>){const list=new ForegroundSessionList(cliPath);return new SqliteForeground({ownerId,probe:new NativeForegroundProbe({executable:probePath}),snapshot,sessions:(a,o)=>list.sessions(a,o),closeSessions:()=>list.close(),invalidateSessions:()=>list.reset(),confirmBinding,requestSessionRefresh:()=>list.requestRefresh()});}
 observe(signal?:AbortSignal):Promise<ForegroundObservation>{
  if(this.closed||this.changing)throw new ForegroundLocationError('foreground_observation_cancelled');
  if(this.active||this.confirming)throw new ForegroundLocationError('foreground_observation_busy');
  this.pendingConfirmation=undefined;
  const work=(async()=>{
   const before=await this.options.snapshot();
   if(this.closed||this.changing||signal?.aborted)throw new ForegroundLocationError('foreground_observation_cancelled');
   if(!before.enabled)return {observation_id:randomUUID(),observed_at:new Date().toISOString(),phase:'paused',reason:'sync_disabled',probe_available:false,wechat_in_front:false,binding_id:null,contact_id:null,recognized_name:null,recognition_confidence:null} as ForegroundObservation;
   if(!before.account)throw new ForegroundLocationError('foreground_scope_unavailable');
   const account=before.account,key=JSON.stringify(before);
   if(!this.locator||this.locatorAccount!==key){await this.locator?.invalidate();this.locatorAccount=key;this.locator=new ForegroundLocator({ownerId:this.options.ownerId,accountScope:account.key,probe:this.options.probe,
    sessions:o=>this.options.sessions(account,o),bindings:async(_signal,check)=>{const current=await this.options.snapshot();check();if(JSON.stringify(current)!==JSON.stringify(before))throw new ForegroundLocationError('foreground_scope_unavailable');return current.bindings.map(b=>({...b,owner_id:this.options.ownerId,channel:'wechat',account_scope:account.key}));}});}
   const result=await this.locator.observe({enabled:true,signal});const after=await this.options.snapshot();
   if(this.closed||this.changing||signal?.aborted||JSON.stringify(before)!==JSON.stringify(after))throw new ForegroundLocationError('foreground_observation_cancelled');
   // 名称在缓存名单里找不到或有歧义时，名单可能已过期：只触发后台重读，不影响本轮结果。
   if(result.phase==='manual-required'&&(result.reason==='unmatched_requires_selection'||result.reason==='ambiguous_requires_selection'))this.options.requestSessionRefresh?.();
   const age=Date.now()-Date.parse(result.observed_at);if(result.phase==='confirmed'&&(!Number.isFinite(age)||age< -1000||age>=5000))throw new ForegroundLocationError('observation_timeout');
   // SQLite只提供稳定绑定；名称识别成功后直接关联已有联系人，不创建或改写身份/读取授权。
   if(result.phase==='confirmed'){
    const binding=before.bindings.find(b=>b.binding_id===result.binding_id&&b.contact_id===result.contact_id);
    if(binding?.grant_id)this.pendingConfirmation={snapshot:key,proof:{observationId:result.observation_id,observedAt:result.observed_at,
     contactId:binding.contact_id,bindingId:binding.binding_id,readEpoch:before.readEpoch,accountId:account.id,sourceGeneration:account.sourceGeneration,
     scopeRevision:account.revision,grantId:binding.grant_id,selectionGeneration:binding.selection_generation,dataGeneration:binding.dataGeneration,barrierGeneration:binding.barrierGeneration}};
   }
   return result;
  })();this.active=work;void work.finally(()=>{if(this.active===work)this.active=undefined;}).catch(()=>{});return work;
 }
 confirm(contactId:string,observationId:string,signal?:AbortSignal):Promise<{confirmed:true}>{
  const pending=this.pendingConfirmation;
  if(this.closed||this.changing||this.active||this.confirming||signal?.aborted||!pending||pending.proof.observationId!==observationId||!this.options.confirmBinding)
   return Promise.reject(new ForegroundLocationError('foreground_confirmation_stale'));
  if(pending.proof.contactId!==contactId)return Promise.reject(new ForegroundLocationError('foreground_binding_required'));
  this.pendingConfirmation=undefined;
  const check=()=>{const age=Date.now()-Date.parse(pending.proof.observedAt);if(this.closed||this.changing||signal?.aborted||!Number.isFinite(age)||age< -1000||age>=5000)throw new ForegroundLocationError('foreground_confirmation_stale');};
  const work=(async()=>{
   check();const current=await this.options.snapshot();check();
   if(JSON.stringify(current)!==pending.snapshot)throw new ForegroundLocationError('foreground_confirmation_stale');
   await this.options.confirmBinding!(pending.proof);check();return {confirmed:true as const};
  })();
  this.confirming=work;void work.finally(()=>{if(this.confirming===work)this.confirming=undefined;}).catch(()=>{});return work;
 }
 async invalidate(){this.pendingConfirmation=undefined;await this.locator?.invalidate();if(this.active||this.confirming)await Promise.allSettled([this.active,this.confirming]);await this.options.invalidateSessions?.();}
 async screenPermissionRestored(){
  if(this.closed)throw new ForegroundLocationError('foreground_observation_cancelled');
  const release=await this.beginChange();
  try{if(this.closed)throw new ForegroundLocationError('foreground_observation_cancelled');this.options.probe.resetPermissionGate?.();}
  finally{release();}
 }
 async beginChange(){this.changing++;try{await this.invalidate();}catch(e){this.changing--;throw e;}let done=false;return ()=>{if(!done){done=true;this.changing--;}};}
 async close(){this.closed=true;await this.invalidate();if(this.locator)await this.locator.close();else await this.options.probe.dispose();await this.options.closeSessions();}
}
