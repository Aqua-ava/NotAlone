/** 原公开 prepare 的有界短期等待句柄；正文不进入结果缓存，权威恢复来自 A/C 表。 */
import {randomUUID} from 'node:crypto';
import {fingerprint} from '../generation/reply-assistant-erasure.ts';
import type {VerifiedReplyScope} from '../generation/reply-scope.ts';
import type {AssistantGenerationResponse} from './assistant-generation-lifecycle.ts';
interface PreparationJob {id:string;scope:string;key:string;fingerprint:string;controller:AbortController;promise:Promise<void>;result:AssistantGenerationResponse|null;finished:number|null}
const pending=(job:PreparationJob):AssistantGenerationResponse=>({status:202,payload:{preparation_id:job.id,state:'preparing'}});
const allowed=new Set(['session_id','turn_id','request_key','input_version_id','state','error','reason','no_generation','input_budget','message']);
export class AssistantGenerationJobs {
 private readonly jobs=new Map<string,PreparationJob>();
 private stopped=false;
 private identity(scope:VerifiedReplyScope,path:string):string{return `${scope.owner_id}:${scope.contact_id}:${scope.confirmation}:${scope.conversation_binding_id}:${path}`;}
 private clean(){const now=Date.now();for(const [id,job] of this.jobs)if(job.finished!==null&&now-job.finished>=300000)this.jobs.delete(id);}
 start(scope:VerifiedReplyScope,path:string,key:string,body:unknown,run:(signal:AbortSignal)=>Promise<AssistantGenerationResponse>):AssistantGenerationResponse {
  this.clean();if(this.stopped)return {status:503,payload:{error:'runtime_stopping'}};
  const identity=this.identity(scope,path),hash=fingerprint(body);
  for(const job of this.jobs.values())if(job.scope===identity&&job.key===key&&job.result===null)return job.fingerprint===hash?pending(job):{status:409,payload:{error:'assistant_session_input_conflict'}};
  if([...this.jobs.values()].filter(job=>job.result===null).length>=4)return {status:503,payload:{error:'assistant_preparation_busy'}};
  if(this.jobs.size>=64){const completed=[...this.jobs.values()].filter(job=>job.finished!==null).sort((a,b)=>a.finished!-b.finished!);if(!completed.length)return {status:503,payload:{error:'assistant_preparation_busy'}};this.jobs.delete(completed[0].id);}
  const controller=new AbortController(),job:PreparationJob={id:randomUUID(),scope:identity,key,fingerprint:hash,controller,promise:Promise.resolve(),result:null,finished:null};
  const timer=setTimeout(()=>controller.abort('deadline'),120000);timer.unref();
  this.jobs.set(job.id,job);
  job.promise=Promise.resolve().then(async()=>{
   let result:AssistantGenerationResponse;
   try{controller.signal.throwIfAborted();result=await run(controller.signal);controller.signal.throwIfAborted();}
   catch{result=controller.signal.aborted?controller.signal.reason==='deadline'?{status:504,payload:{error:'assistant_preparation_timeout'}}:controller.signal.reason==='runtime_stopping'?{status:503,payload:{error:'runtime_stopping'}}:{status:409,payload:{error:'assistant_preparation_cancelled'}}:{status:500,payload:{error:'internal_error'}};}
   clearTimeout(timer);const payload=result.payload as Record<string,unknown>;job.result={status:result.status,payload:Object.fromEntries(Object.entries(payload).filter(([key])=>allowed.has(key)))};job.finished=Date.now();
  });return pending(job);
 }
 status(scope:VerifiedReplyScope,path:string,id:string,cancel=false):AssistantGenerationResponse {
  this.clean();const job=this.jobs.get(id);if(!job||job.scope!==this.identity(scope,path))return {status:404,payload:{error:'not_found'}};
  if(cancel&&job.result===null){job.controller.abort('cancelled');return pending(job);}return job.result??pending(job);
 }
 async drain():Promise<void>{this.stopped=true;for(const job of this.jobs.values())if(job.result===null)job.controller.abort('runtime_stopping');await Promise.allSettled([...this.jobs.values()].map(job=>job.promise));}
}
