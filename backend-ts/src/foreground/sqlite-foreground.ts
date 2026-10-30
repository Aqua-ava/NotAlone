import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ForegroundLocator,ForegroundLocationError,type ForegroundProbe,type ForegroundSession,type ForegroundObservation} from './foreground-location-locator.ts';
import {NativeForegroundProbe} from './foreground-location-probe.ts';
import {loadNarrowWechatOptions} from '../history/wechat/artifacts.ts';
import {NarrowWechatClient} from '../history/wechat/native-client.ts';
import type {SavedContactBinding} from '../contacts/sqlite/contracts.ts';

export interface ForegroundSnapshot {enabled:boolean;readEpoch:string;account:{id:string;key:string;sourceGeneration:string;revision:string}|null;bindings:(SavedContactBinding&{desktopVerified:boolean;dataGeneration:string;barrierGeneration:string})[]}
export interface ForegroundBindingConfirmation {
 observationId:string;observedAt:string;contactId:string;bindingId:string;readEpoch:string;
 accountId:string;sourceGeneration:string;scopeRevision:string;grantId:string;selectionGeneration:string;dataGeneration:string;barrierGeneration:string;
}
const exec=promisify(execFile);
/** 已核验的固定只读 CLI 只枚举会话身份、名称和类型；不请求消息正文。 */
export class ForegroundSessionList {
 private client?:NarrowWechatClient;
 private closed=false;
 private readonly executable:string;
 constructor(executable:string){this.executable=executable;}
 async sessions(account:NonNullable<ForegroundSnapshot['account']>,options:{signal:AbortSignal;timeoutMs:number;limit:number;keyword?:string}):Promise<ForegroundSession[]>{
  if(this.closed||options.signal.aborted)throw new ForegroundLocationError('foreground_observation_cancelled');
  try{
   this.client??=new NarrowWechatClient(await loadNarrowWechatOptions(this.executable));
   const before=await this.client.accountMetadata(options.signal);
   if(before.status!=='verified'||before.accountKey!==account.key||before.sourceGeneration!==account.sourceGeneration)throw new Error();
   const config=process.env.NOTALONE_WECHAT_CONFIG;
   if(!config||!config.startsWith('/')||/[\0\r\n]/.test(config))throw new Error();
   const args=['sessions','--type-filter','all','--limit',String(options.limit),'--strict-read-only'];
   if(options.keyword!==undefined)args.push('--keyword',options.keyword);
   const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:process.env.HOME,LANG:process.env.LANG,WECHAT_CLI_CONFIG:config};
   const {stdout}=await exec(this.executable,args,{env,timeout:Math.max(1,options.timeoutMs),signal:options.signal,maxBuffer:1024*1024});
   const envelope=JSON.parse(stdout),data=envelope?.data;
   if(envelope?.ok!==true||!Array.isArray(data?.sessions)||data.sessions.length>=options.limit||data.warnings?.length||data.freshness?.metadata_cache_status!=='ready')throw new Error();
   const rows:ForegroundSession[]=data.sessions.map((row:Record<string,unknown>)=>{
    if(!row||typeof row.username!=='string'||!row.username||typeof row.display_name!=='string'||!row.display_name||[...row.display_name].length>256||typeof row.chat_type!=='string'||!row.chat_type||Object.keys(row).some(k=>!['username','display_name','chat_type','last_timestamp','sort_timestamp'].includes(k)))throw new Error();
    return {username:row.username,display_name:row.display_name,chat_type:row.chat_type};
   });
   const after=await this.client.accountMetadata(options.signal);
   if(JSON.stringify(before)!==JSON.stringify(after))throw new Error();
   return rows;
  }catch(error){const old=this.client;this.client=undefined;await old?.close();throw error;}
 }
 async reset(){const old=this.client;this.client=undefined;await old?.close();}
 async close(){this.closed=true;await this.reset();}
}

/** 每轮复核当前授权范围与绑定；变更、删除和关闭先排空已接受观察。 */
export class SqliteForeground {
 private locator?:ForegroundLocator;
 private locatorAccount?:string;
 private sessionNamesComplete=false;
 private closed=false;
 private changing=0;
 private active?:Promise<ForegroundObservation>;
 private confirming?:Promise<{confirmed:true}>;
 private pendingConfirmation?:{snapshot:string;proof:ForegroundBindingConfirmation};
 private readonly options:{ownerId:string;probe:ForegroundProbe;snapshot:()=>Promise<ForegroundSnapshot>;sessions:(account:NonNullable<ForegroundSnapshot['account']>,options:{signal:AbortSignal;timeoutMs:number;limit:number;keyword?:string})=>Promise<ForegroundSession[]>;closeSessions:()=>Promise<void>;invalidateSessions?:()=>Promise<void>;confirmBinding?:(proof:ForegroundBindingConfirmation)=>Promise<void>};
 constructor(options:SqliteForeground['options']){this.options=options;}
 static create(ownerId:string,probePath:string,cliPath:string,snapshot:()=>Promise<ForegroundSnapshot>,confirmBinding?:(proof:ForegroundBindingConfirmation)=>Promise<void>){const list=new ForegroundSessionList(cliPath);return new SqliteForeground({ownerId,probe:new NativeForegroundProbe({executable:probePath}),snapshot,sessions:(a,o)=>list.sessions(a,o),closeSessions:()=>list.close(),invalidateSessions:()=>list.reset(),confirmBinding});}
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
    sessions:async o=>{const rows=await this.options.sessions(account,o);this.sessionNamesComplete=!rows.some(row=>row.chat_type==='group'&&row.display_name===row.username);return rows;},bindings:async(_signal,check)=>{const current=await this.options.snapshot();check();if(JSON.stringify(current)!==JSON.stringify(before))throw new ForegroundLocationError('foreground_scope_unavailable');return current.bindings.map(b=>({...b,owner_id:this.options.ownerId,channel:'wechat',account_scope:account.key}));}});}
   const result=await this.locator.observe({enabled:true,signal});const after=await this.options.snapshot();
   if(this.closed||this.changing||signal?.aborted||JSON.stringify(before)!==JSON.stringify(after))throw new ForegroundLocationError('foreground_observation_cancelled');
   const age=Date.now()-Date.parse(result.observed_at);if(result.phase==='confirmed'&&(!Number.isFinite(age)||age< -1000||age>=5000))throw new ForegroundLocationError('observation_timeout');
   // 渠道元数据只证明配置来源，不证明前台微信登录的是该账号；仅桌面确认过的绑定可自动授予身份。
   if(result.phase==='confirmed'&&(!this.sessionNamesComplete||!before.bindings.some(b=>b.binding_id===result.binding_id&&b.desktopVerified))){
    const binding=before.bindings.find(b=>b.binding_id===result.binding_id&&b.contact_id===result.contact_id);
    // 仅完整名单下的唯一既有私聊可供本次明确确认；名称和身份事实不由页面提供。
    if(this.sessionNamesComplete&&binding?.grant_id)this.pendingConfirmation={snapshot:key,proof:{observationId:result.observation_id,observedAt:result.observed_at,
     contactId:binding.contact_id,bindingId:binding.binding_id,readEpoch:before.readEpoch,accountId:account.id,sourceGeneration:account.sourceGeneration,
     scopeRevision:account.revision,grantId:binding.grant_id,selectionGeneration:binding.selection_generation,dataGeneration:binding.dataGeneration,barrierGeneration:binding.barrierGeneration}};
    return {...result,phase:'manual-required' as const,reason:'unmatched_requires_selection',binding_id:null,contact_id:null};
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
