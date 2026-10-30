import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import { loadNarrowWechatOptions } from '../wechat/artifacts.ts';
import { NarrowWechatClient } from '../wechat/native-client.ts';
import type { HistoryChannel, HistoryScope, HistorySupportReport, HistoryTarget } from './contracts.ts';
import { prepareBoundaryCandidate } from './boundary.ts';

function unavailableReport():HistorySupportReport {
 const report:HistorySupportReport={protocol:'private-history-v1',profileId:'wechat-private-history-unverified-v1',adapterVersion:'1',
  status:'unverified',reason:'wechat_final_artifact_and_schema_unverified',
  accountKey:'unverified',conversationKey:'unverified',sourceGeneration:'unverified',
  programVersion:'unknown',build:'unknown',artifactSha256:'',schemaFingerprint:'',declaredPrimaryKey:[],
  identity:'source-table-local-v1',statusSemantics:'',continuity:''};
 return report;
}
const reject=(code:string):never=>{throw new StorageFailure(code);};
function scopeIdentity(scope:HistoryScope):string {
 const required=['owner_id','contact_id','account_id','conversation_id','binding_id','grant_id','verification_id','read_epoch','selection_generation','data_generation','identity_generation','scope_revision','barrier_generation','source_generation'];
 if(!scope||typeof scope!=='object'||!scope.token||typeof scope.token!=='object'
  ||typeof scope.accountKey!=='string'||typeof scope.conversationKey!=='string'
  ||![scope.accountKey,scope.conversationKey].every(value=>/^[A-Za-z0-9_.@-]{1,255}$/.test(value)))return reject('history_scope_unverified');
 const token=scope.token as unknown as Record<string,unknown>;
 if(required.some(key=>!Object.hasOwn(token,key))||Object.values(token).some(value=>typeof value!=='string'||!value.length||value.length>2048||/[\u0000-\u001f\u007f]/.test(value)))return reject('history_scope_unverified');
 return JSON.stringify([scope.accountKey,scope.conversationKey,Object.keys(token).sort().map(key=>[key,token[key]])]);
}
/** 每实例只绑定一个完整授权token；只经正式窄协议读取，不自动寻找工具或提升支持资格。 */
class WechatHistoryChannel implements HistoryChannel {
 readonly #guardLoss=Promise.withResolvers<void>();
 readonly guardSession={loss:this.#guardLoss.promise,failureCode:()=>this.#native?.stoppedReason??null};
 readonly #executable?:string;
 #native?:NarrowWechatClient;
 #opening?:Promise<NarrowWechatClient>;
 #identity?:string;
 #scope?:HistoryScope;
 #targetIssued=false;
 #closed=false;
 constructor(executable?:string){this.#executable=executable;}
 async #open(signal?:AbortSignal):Promise<NarrowWechatClient>{
  try{
   const options=await loadNarrowWechatOptions(this.#executable!);
   if(signal?.aborted)return reject('history_native_cancelled');
   if(this.#closed)return reject('history_native_closed');
   const native=new NarrowWechatClient(options);this.#native=native;void native.stopped.then(()=>this.#guardLoss.resolve());
   const scope=this.#scope!,resolved=await native.resolveSelected(scope.conversationKey,signal);
   if(resolved.accountKey!==scope.accountKey)return reject('history_account_changed');
   if(resolved.conversationKey!==scope.conversationKey)return reject('history_scope_changed');
   if(resolved.sourceGeneration!==scope.token.source_generation)return reject('history_source_changed');
   return native;
  }catch(error){
   this.#closed=true;await this.#native?.close();
   throw error instanceof StorageFailure?error:new StorageFailure('history_native_unavailable');
  }
 }
 async #client(scope:HistoryScope,signal?:AbortSignal):Promise<NarrowWechatClient>{
  if(this.#closed)return reject('history_native_closed');
  if(signal!==undefined&&!(signal instanceof AbortSignal))return reject('history_request_invalid');
  if(signal?.aborted){await this.close();return reject('history_native_cancelled');}
  const identity=scopeIdentity(scope);
  if(this.#identity!==undefined&&identity!==this.#identity){await this.close();return reject('history_scope_changed');}
  if(this.#identity===undefined){this.#identity=identity;this.#scope=structuredClone(scope);}
  return this.#opening??=this.#open(signal);
 }
 async #run<T>(scope:HistoryScope,signal:AbortSignal|undefined,work:(native:NarrowWechatClient)=>Promise<T>):Promise<T>{
  if(signal!==undefined&&!(signal instanceof AbortSignal))return reject('history_request_invalid');
  const abort=()=>{void this.close().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  try{return await work(await this.#client(scope,signal));}
  catch(error){
   // 守卫会因协议失败主动中断当前读取，不能把原始故障改写成用户取消。
   if(signal?.aborted&&(!(error instanceof StorageFailure)||error.code==='history_native_closed'))return reject('history_native_cancelled');
   throw error;
  }
  finally{signal?.removeEventListener('abort',abort);if(signal?.aborted)await this.close();}
 }
 async inspect(scope:HistoryScope,signal?:AbortSignal):Promise<HistorySupportReport>{
  if(!this.#executable){if(this.#closed)return reject('history_native_closed');return unavailableReport();}
  return this.#run(scope,signal,async native=>{await native.inspectSelected(signal);return native.supportSelected(signal);});
 }
 async target(scope:HistoryScope,signal?:AbortSignal):Promise<HistoryTarget>{
  if(!this.#executable)return reject('history_support_unverified');
  return this.#run(scope,signal,async native=>{const target=await native.targetSelected(signal);this.#targetIssued=true;return target;});
 }
 async page(scope:HistoryScope,target:HistoryTarget,cursor:string|null,signal?:AbortSignal){
  if(!this.#executable)return reject('history_support_unverified');
  return this.#run(scope,signal,async native=>{
   try{return await native.pageSelected(target,cursor,signal);}
   catch(error){if(!this.#targetIssued&&error instanceof StorageFailure&&error.code==='history_target_unverified')return reject('history_cursor_invalid');throw error;}
  });
 }
 async tail(scope:HistoryScope,target:HistoryTarget,cursor:string,signal?:AbortSignal){
  if(!this.#executable)return reject('history_support_unverified');
  return this.#run(scope,signal,native=>native.tailSelected(target,cursor,signal));
 }
 async boundarySnapshot(scope:HistoryScope,signal?:AbortSignal){
  if(!this.#executable)return reject('history_support_unverified');
  return this.#run(scope,signal,async native=>{
   await native.inspectSelected(signal);await native.supportSelected(signal);
   const candidate=await native.boundarySnapshotSelected(signal);
   prepareBoundaryCandidate(scope,candidate);return candidate;
  });
 }
 async close():Promise<void>{
  this.#closed=true;this.#guardLoss.resolve();await this.#native?.close();
  try{await this.#opening;}catch{/* 已失败的初始化也必须排空，不能再次打开读者。 */}
  await this.#native?.close();
 }
}
export function createWechatHistoryChannel(executable?:string):HistoryChannel{return new WechatHistoryChannel(executable);}
