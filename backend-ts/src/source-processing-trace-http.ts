/** 宿主公开追踪路由；只接已鉴权联系人范围，不启动模型或读取请求正文。 */
import type {
 MemoryTraceRecordKind,SourceProcessingRecordKind,SourceProcessingTraceStore,
} from './source-processing-trace.ts';
import {SourceProcessingTraceError} from './source-processing-trace.ts';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface SourceProcessingTraceResponse {status:number;body:unknown}

export class SourceProcessingTraceApi {
 private readonly store:SourceProcessingTraceStore;
 private readonly ownerId:string;
 constructor(store:SourceProcessingTraceStore,ownerId:string) {
  if(!uuid.test(ownerId))throw new SourceProcessingTraceError('trace_owner_invalid');
  this.store=store;this.ownerId=ownerId.toLowerCase();
 }

 /** 返回 null 表示不是本适配器路由；匹配但方法不支持时返回 405，避免落到旧后端。 */
 async handle(method:string,url:URL):Promise<SourceProcessingTraceResponse|null> {
  const route=url.pathname.match(/^\/api\/contacts\/([^/]+)\/(memory-traces|source-processing-traces)(?:\/(.*))?$/);
  if(!route)return null;
  const contact=route[1]!,resource=route[2]! as 'memory-traces'|'source-processing-traces';
  const tail=(route[3]??'').replace(/\/$/,'');
  if(!uuid.test(contact))return this.bad('trace_request_invalid');
  const scope={ownerId:this.ownerId,contactId:contact.toLowerCase()};
  const query=this.query(url,!tail);
  if(!query.ok)return this.bad('trace_request_invalid');
  try{
   if(!tail){
    if(method!=='GET')return this.method();
    const page=resource==='memory-traces'
      ?await this.store.listMemoryTraces(scope,query.options)
      :await this.store.listSourceBatches(scope,query.options);
    return {status:200,body:page};
   }
   const memory=tail.match(/^records\/(message|candidate|contact_memory|owner_memory|task)\/([^/]+)$/);
   if(resource==='memory-traces'&&memory){
    if(method!=='GET')return this.method();if(!uuid.test(memory[2]!))return this.bad('trace_request_invalid');
    return {status:200,body:await this.store.findMemoryTraceRecord(scope,memory[1] as MemoryTraceRecordKind,memory[2]!)};
   }
   const task=tail.match(/^tasks\/([^/]+)$/);
   if(resource==='memory-traces'&&task){
    if(method!=='GET')return this.method();if(!uuid.test(task[1]!))return this.bad('trace_request_invalid');
    return {status:200,body:await this.store.findTaskTrace(scope,task[1]!)};
   }
   const sourceRecord=tail.match(/^records\/(message|source_ref|source_document|local_wechat_observation)\/([^/]+)$/);
   if(resource==='source-processing-traces'&&sourceRecord){
    if(method!=='GET')return this.method();if(!uuid.test(sourceRecord[2]!))return this.bad('trace_request_invalid');
    return {status:200,body:await this.store.findSourceRecord(scope,
     sourceRecord[1] as SourceProcessingRecordKind,sourceRecord[2]!)};
   }
   const diagnostic=tail.match(/^([^/]+)\/diagnostics$/);
   if(resource==='memory-traces'&&diagnostic){
    if(method!=='GET')return this.method();if(!uuid.test(diagnostic[1]!))return this.bad('trace_request_invalid');
    return {status:200,body:await this.store.diagnoseMemoryTrace(scope,diagnostic[1]!)};
   }
   const detail=tail.match(/^([^/]+)$/);
   if(detail&&uuid.test(detail[1]!)){
    if(!['GET','DELETE'].includes(method))return this.method();
    if(method==='DELETE')return {status:200,body:resource==='memory-traces'
      ?await this.store.deleteMemoryTrace(scope,detail[1]!)
      :await this.store.deleteSourceBatch(scope,detail[1]!)};
    return {status:200,body:resource==='memory-traces'
      ?await this.store.getMemoryTrace(scope,detail[1]!)
      :await this.store.getSourceBatch(scope,detail[1]!)};
   }
   return this.bad('trace_request_invalid');
  }catch(error){
   return this.failure(error);
  }
 }

 private query(url:URL,list:boolean):{ok:true;options:{limit?:number;before?:string|null}}|{ok:false} {
  if(!list&&url.search)return {ok:false};
  if(!list)return {ok:true,options:{}};
  const allowed=new Set(['limit','before']);
  for(const key of url.searchParams.keys())if(!allowed.has(key)||url.searchParams.getAll(key).length!==1)return {ok:false};
  const limitText=url.searchParams.get('limit'),before=url.searchParams.get('before');
  if(limitText!==null&&(!/^[1-9][0-9]{0,2}$/.test(limitText)||Number(limitText)>500))return {ok:false};
  if(before!==null&&!uuid.test(before))return {ok:false};
  return {ok:true,options:{...(limitText!==null?{limit:Number(limitText)}:{}),before:before?.toLowerCase()??null}};
 }
 private bad(code:string):SourceProcessingTraceResponse{return {status:400,body:{error:code}};}
 private method():SourceProcessingTraceResponse{return {status:405,body:{error:'method_not_allowed'}};}
 private failure(error:unknown):SourceProcessingTraceResponse {
  if(!(error instanceof SourceProcessingTraceError))return {status:503,body:{error:'source_processing_trace_unavailable'}};
  if(['trace_scope_invalid','trace_identifier_invalid','trace_id_invalid','trace_record_id_invalid',
   'trace_task_id_invalid','trace_record_kind_invalid','source_processing_batch_id_invalid',
   'source_processing_record_kind_invalid','source_processing_record_id_invalid','trace_page_invalid',
   'trace_cursor_invalid'].includes(error.code))return this.bad(error.code);
  if(['trace_not_found','trace_task_not_found','trace_record_not_found','trace_cursor_not_found',
   'source_processing_not_found','source_processing_record_not_found','source_unavailable',
   'trace_sources_unavailable'].includes(error.code))return {status:404,body:{error:error.code}};
  return {status:503,body:{error:'source_processing_trace_unavailable'}};
 }
}
