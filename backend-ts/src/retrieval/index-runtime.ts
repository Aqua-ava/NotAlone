import {randomUUID} from 'node:crypto';
import {StorageFailure} from '../storage/sqlite/contracts.ts';
import type {SqliteStorage} from '../storage/sqlite/client.ts';
import type {ActiveHolders} from '../storage/sqlite/deletion/holders.ts';
import type {EmbedTexts} from './retrieval-hybrid.ts';
import {RETRIEVAL_MODEL_FINGERPRINT,type RetrievalKind,type VectorIndexItem} from './sqlite/contracts.ts';

/** 本机固定表示版本；正文向量可持久复用，query与本轮得分不持久化。 */
export const RETRIEVAL_EMBEDDING_FINGERPRINT=RETRIEVAL_MODEL_FINGERPRINT;
export interface RetrievalWakeScope {contactId?:string;kind?:RetrievalKind}
export interface RetrievalQueryScope extends RetrievalWakeScope {generation:bigint;holderKeys?:readonly string[];coversAllContacts?:boolean}
export interface RetrievalQueryVector {vector?:readonly number[];strategy:'hybrid'|'bm25';indexIncomplete:boolean}
export interface RetrievalIndexLifecycle {
 start():void;
 wake(scope?:RetrievalWakeScope):void;
 queryVector(query:string,signal:AbortSignal,scope?:RetrievalQueryScope):Promise<RetrievalQueryVector>;
 flushForTests():Promise<void>;
 close():Promise<void>;
}
interface Pending {textPending:number;vectorPending:number}
interface Options {
 storage:Pick<SqliteStorage,'execute'>;ownerId:string;holders:ActiveHolders;embed?:EmbedTexts;fingerprint?:string;
 /** 后台单批有界；空闲探测及故障重试各仅保留一个timer。 */
 batchSize?:number;idleMs?:number;retryMs?:number;queryTimeoutMs?:number;
}
interface LaneTask {run:()=>Promise<void>}
type DrainResult='idle'|'yield';
const stopped=()=>new StorageFailure('retrieval_runtime_closed');
function validVectors(vectors:readonly (readonly number[])[],count:number):boolean{return vectors.length===count&&vectors.every(v=>v.length===512&&v.every(Number.isFinite)&&v.some(x=>x!==0));}

/** 派生索引只处理已接纳本机资料；模型与事务分离，后台不创建Agent或外部调用。 */
export function createRetrievalIndex(options:Options):RetrievalIndexLifecycle {
 const fingerprint=options.fingerprint??RETRIEVAL_EMBEDDING_FINGERPRINT;
 const batchSize=Math.max(1,Math.min(16,Math.floor(options.batchSize??8)));
 const idleMs=Math.max(1000,options.idleMs??30_000),retryMs=Math.max(1000,options.retryMs??60_000);
 const high:LaneTask[]=[],low:LaneTask[]=[],operations=new Set<Promise<unknown>>(),controllers=new Set<AbortController>();
 // 最近使用范围只作有界调度偏好；完成一次固定尾界扫描后释放，再继续全局积压。
 const preferredScopes:RetrievalWakeScope[]=[];
 const releasePreference=(scope?:RetrievalWakeScope)=>{
  if(scope===undefined)return false;
  const index=preferredScopes.findIndex(item=>item.contactId===scope.contactId&&item.kind===scope.kind);if(index>=0)preferredScopes.splice(index,1);
  return true;
 };
 let laneRunning=false,closed=false,started=false,timer:ReturnType<typeof setTimeout>|undefined,draining:Promise<DrainResult>|undefined,closing:Promise<void>|undefined,retryAt=0;
 const execute=<T>(name:string,input:object)=>options.storage.execute<T>(name,{ownerId:options.ownerId,...input});
 const pending=(scope?:RetrievalWakeScope)=>execute<Pending>('retrieval.pending',{modelFingerprint:fingerprint,...(scope?.contactId?{contactId:scope.contactId}:{}),...(scope?.kind?{kind:scope.kind}:{})});
 const schedule=(delay:number)=>{
  if(!started||closed||timer)return;
  timer=setTimeout(()=>{timer=undefined;void drain().catch(()=>{});},delay);timer.unref();
 };
 const pump=async()=>{
  if(laneRunning)return;laneRunning=true;
  try{while(high.length||low.length)await (high.shift()??low.shift())!.run();}
  finally{laneRunning=false;}
 };
 const enqueue=<T>(priority:'query'|'backfill',run:()=>Promise<T>):Promise<T>=>new Promise((resolve,reject)=>{
  (priority==='query'?high:low).push({run:async()=>{try{resolve(await run());}catch(error){reject(error);}}});void pump();
 });
 /** close回调等待真实推理settle；取消等待不会提前释放仍持有正文的operation。 */
 const held=<T>(scopes:RetrievalQueryScope[],run:(signal:AbortSignal)=>Promise<T>):Promise<T>=>{
  const controller=new AbortController();controllers.add(controller);
  let settle!:()=>void;const settled=new Promise<void>(resolve=>{settle=resolve;}),releases:(()=>Promise<void>)[]=[];
  const operation=(async()=>{
   try{
    if(closed)throw stopped();
    for(const scope of scopes)releases.push(options.holders.register({key:`retrieval:${randomUUID()}`,ownerId:options.ownerId,contactId:scope.contactId,generation:scope.generation,
     scopeKeys:scope.holderKeys,coversAllContacts:scope.coversAllContacts,coversAllSources:scope.contactId!==undefined,
     close:async()=>{controller.abort(stopped());await settled;}}));
    return await run(controller.signal);
   }finally{settle();controllers.delete(controller);await Promise.all(releases.map(release=>release()));}
  })();
  operations.add(operation);const remove=()=>operations.delete(operation);operation.then(remove,remove);return operation;
 };
 const infer=(texts:readonly string[],priority:'query'|'backfill',signal:AbortSignal)=>enqueue(priority,async()=>{
  signal.throwIfAborted();if(closed)throw stopped();
  const vectors=await options.embed!(texts);
  signal.throwIfAborted();if(closed)throw stopped();
  if(!validVectors(vectors,texts.length))throw new StorageFailure('retrieval_embedding_invalid');
  return vectors;
 });
 const backfill=async(items:VectorIndexItem[])=>held(items.map(item=>({contactId:item.contactId??undefined,generation:item.generation,holderKeys:item.holderKeys,coversAllContacts:item.coversAllContacts})),async signal=>{
  const vectors=await infer(items.map(item=>item.text),'backfill',signal);
  signal.throwIfAborted();if(closed)throw stopped();
  return execute<{committed:number;rejected:number}>('retrieval.commitVectorBatch',{items:items.map((item,n)=>({docId:item.docId,bodySeal:item.bodySeal,generation:item.generation,modelFingerprint:fingerprint,vector:vectors[n]}))});
 });
 async function drain():Promise<DrainResult>{
  if(closed)return 'idle';
  if(draining)return draining;
  const current=(async():Promise<DrainResult>=>{
   try{
    const deadline=performance.now()+1000;let pages=0;
    while(!closed){
     // 每轮固定计算上界；无效前缀逐页推进，达到预算后由单timer续扫。
     if(++pages>64||performance.now()>=deadline){schedule(250);return 'yield';}
     const scope=preferredScopes[0];
     const text=await execute<{processed:number;remaining:number}>('retrieval.syncTextBatch',{...scope,limit:128});
     if(closed)return 'idle';
     if(text.remaining>0){await new Promise<void>(resolve=>setImmediate(resolve));continue;}
     if(!options.embed||Date.now()<retryAt){
      if(releasePreference(scope)){await new Promise<void>(resolve=>setImmediate(resolve));continue;}
      schedule(Math.max(idleMs,retryAt-Date.now()));return 'idle';
     }
     const batch=await execute<{items:VectorIndexItem[];remaining:number;scanMore?:boolean}>('retrieval.claimVectorBatch',{...scope,limit:batchSize,modelFingerprint:fingerprint});
     if(closed)return 'idle';
     if(!batch.items.length){
      if(batch.scanMore){await new Promise<void>(resolve=>setImmediate(resolve));continue;}
      if(releasePreference(scope)){await new Promise<void>(resolve=>setImmediate(resolve));continue;}
      schedule(idleMs);return 'idle';
     }
     const result=await backfill(batch.items);
     // CAS拒绝表示业务已变化；下次重新取合法快照，不在本轮反复读取同一项。
     if(result.rejected){schedule(idleMs);return 'idle';}
     if(!batch.remaining||batch.scanMore===false){
      if(releasePreference(scope)){await new Promise<void>(resolve=>setImmediate(resolve));continue;}
      schedule(idleMs);return 'idle';
     }
     await new Promise<void>(resolve=>setImmediate(resolve));
    }
    return 'idle';
   }catch(error){if(!closed){retryAt=Date.now()+retryMs;schedule(retryMs);}throw error;}
  })();
  draining=current;
  try{return await current;}finally{if(draining===current)draining=undefined;}
 }
 const lifecycle:RetrievalIndexLifecycle={
  start(){if(closed||started)return;started=true;lifecycle.wake({kind:'memory'});},
  wake(scope){
   if(closed)return;
   if(scope?.contactId||scope?.kind){
    releasePreference(scope);preferredScopes.unshift({...(scope.contactId?{contactId:scope.contactId}:{}),...(scope.kind?{kind:scope.kind}:{})});if(preferredScopes.length>8)preferredScopes.pop();
   }
   if(timer){clearTimeout(timer);timer=undefined;}if(started)void drain().catch(()=>{});
  },
  async queryVector(query,signal,scope){
   signal.throwIfAborted();if(closed)throw stopped();
   const state=await pending(scope);signal.throwIfAborted();if(closed)throw stopped();
   const indexIncomplete=state.textPending>0||state.vectorPending>0;
   if(!options.embed||Date.now()<retryAt){lifecycle.wake(scope);return {strategy:'bm25',indexIncomplete};}
   const timeout=AbortSignal.timeout(options.queryTimeoutMs??8000),combined=AbortSignal.any([signal,timeout]);
   const operation=held([scope??{generation:0n,coversAllContacts:true}],ownSignal=>infer([query],'query',AbortSignal.any([combined,ownSignal])));
   lifecycle.wake(scope);
   let abort!:()=>void;
   const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(combined.reason);if(combined.aborted)abort();else combined.addEventListener('abort',abort,{once:true});});
   try{const [vector]=await Promise.race([operation,cancelled]);signal.throwIfAborted();return {vector,strategy:'hybrid',indexIncomplete};}
   catch(error){if(signal.aborted)throw signal.reason;if(closed)throw stopped();retryAt=Date.now()+retryMs;return {strategy:'bm25',indexIncomplete};}
   finally{combined.removeEventListener('abort',abort);}
  },
  async flushForTests(){while(!closed&&await drain()==='yield')await new Promise<void>(resolve=>setImmediate(resolve));},
  close(){return closing??=(async()=>{closed=true;started=false;preferredScopes.length=0;if(timer){clearTimeout(timer);timer=undefined;}for(const controller of controllers)controller.abort(stopped());await Promise.allSettled([...(draining?[draining]:[]),...operations]);})().catch(error=>{closing=undefined;throw error;});},
 };
 return lifecycle;
}
