import {build} from 'esbuild';

const compiled=await build({stdin:{contents:`export {HistoryRecertifyBatchController,classifyHistoryRecertifyFailure,createHistoryRecertifyBatchId} from './src/main/history-clear/recertify-batch';
export {HistoryActivityMutex,singleHistoryOperationActive} from './src/main/history-clear/activity';
export {HistoryClearController} from './src/main/history-clear/controller';
export {BackendRequestFailure} from './src/main/backend/json-client';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
export const ports=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
export const contactId=n=>`33333333-3333-4333-8333-${String(n).padStart(12,'0')}`;
export const view=(id,overrides={})=>({contact_id:id,request_key:null,state:'none',stage:'none',completed:false,failure_code:null,
 message_count:0,non_text_count:0,page_count:0,preserved_message_count:0,started_at:null,finished_at:null,...overrides});
export const completedView=(id,key,overrides={})=>view(id,{request_key:key,state:'completed',stage:'completed',completed:true,
 message_count:3,non_text_count:1,page_count:2,preserved_message_count:7,started_at:100,finished_at:200,...overrides});
export const failedView=(id,key,code,interrupted=false,overrides={})=>view(id,{request_key:key,state:interrupted?'interrupted':'failed',stage:'history',
 failure_code:code,started_at:100,finished_at:200,...overrides});
export const runningView=(id,key,overrides={})=>view(id,{request_key:key,state:'running',stage:'history',started_at:100,...overrides});
export const interruptedView=(id,key,code='history_recertify_cancelled')=>failedView(id,key,code,true);
export const batchId='20261106010203abcd';
export async function until(predicate,label='批量状态'){
 for(let attempt=0;attempt<400;attempt++){if(predicate())return;await new Promise(setImmediate);}
 throw new Error(`${label}等待超时`);
}
/** 合成候选与认证后端：只模拟固定 HTTP 合同，不启动真实进程或存储。 */
export function batchFixture(t,{contacts=[contactId(1),contactId(2),contactId(3)],fenced,behaviors={},singleActive=()=>false,options={}}={}){
 const state={generation:1,now:1000,logs:[],calls:[],fenced:new Set(fenced??contacts),behaviors:new Map(Object.entries(behaviors)),singleCandidateHook:null,readEnabled:true};
 const listeners=new Set();
 const candidatesRow=id=>({contact_id:id,fenced:state.fenced.has(id),eligible:true,stored_message_count:10,image_message_count:2,image_unsaved_count:1});
 const candidateResponse=()=>{
  const rows=contacts.map((id,index)=>({...candidatesRow(id),stored_message_count:10+index,image_message_count:index,image_unsaved_count:index}));
  const visible=rows.filter(row=>row.fenced&&row.eligible);
  return {read_enabled:state.readEnabled,fenced_total:rows.filter(row=>row.fenced).length,contacts:visible,total:visible.length,
   with_unsaved_images:visible.filter(row=>row.image_unsaved_count>0).length,
   message_total:visible.reduce((sum,row)=>sum+row.stored_message_count,0),
   image_unsaved_total:visible.reduce((sum,row)=>sum+row.image_unsaved_count,0)};
 };
 const behaviorFor=id=>state.behaviors.get(id);
 const respond=async request=>{
  state.calls.push(request);
  const url=new URL(request.path,'http://synthetic.local');
  if(url.pathname==='/api/history/recertify/candidates'){
   if(url.searchParams.has('contact_id')){
    const id=url.searchParams.get('contact_id');
    if(state.singleCandidateHook)state.singleCandidateHook(id);
    if(!state.readEnabled)return {generation:state.generation,data:{read_enabled:false,fenced_total:state.fenced.size,contacts:[],total:0,with_unsaved_images:0,message_total:0,image_unsaved_total:0}};
    const row=candidatesRow(id);
    return {generation:state.generation,data:{read_enabled:true,fenced_total:row.fenced?1:0,contacts:[row],total:row.fenced&&row.eligible?1:0,
     with_unsaved_images:row.image_unsaved_count>0?1:0,message_total:row.stored_message_count,image_unsaved_total:row.image_unsaved_count}};
   }
   return {generation:state.generation,data:candidateResponse()};
  }
  if(url.pathname==='/api/sync/status')return {generation:state.generation,data:{cli_history_coverages:[{phase:'complete'},{phase:'complete'},{phase:'running'}]}};
  const id=url.pathname.split('/')[3];
  if(!contacts.includes(id))throw new Error('合成后端收到未知联系人路由');
  const behavior=behaviorFor(id);
  if(!behavior)return {generation:state.generation,data:request.method==='POST'
   ?completedView(id,request.body.request_key):completedView(id,url.searchParams.get('request_key'))};
  return await behavior({request,url,state,completed:key=>completedView(id,key),failed:(key,code,interrupted)=>failedView(id,key,code,interrupted),
   running:(key,overrides)=>runningView(id,key,overrides),interrupted:key=>interruptedView(id,key),respond});
 };
 const backend={getConnectionGeneration:()=>state.generation,onStateChanged:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},requestJson:respond};
 state.setGeneration=generation=>{state.generation=generation;for(const listener of listeners)listener({phase:generation===undefined?'disconnected':'connected'});};
 state.listenerCount=()=>listeners.size;
 const activity=new ports.HistoryActivityMutex();
 const controller=new ports.HistoryRecertifyBatchController(backend,activity,singleActive,{
  now:()=>state.now,delay:async()=>{await new Promise(setImmediate);},createBatchId:()=>batchId,log:line=>state.logs.push(line),
  pollInitialMs:1,pollMaxMs:2,interContactMs:0,stallMs:options.stallMs??600_000,admissionGraceMs:options.admissionGraceMs??40,
  statusFailureGraceMs:options.statusFailureGraceMs??100,cancelConfirmMs:options.cancelConfirmMs??100,existingWaitMs:options.existingWaitMs??100});
 t.after(()=>controller.dispose());
 return {controller,activity,backend,state,contacts};
}
/** 合成单联系人历史控制器所需的最少会话：用于核对批量运行期间单操作被拒。 */
export function historyClearFixture(activity){
 const id=contactId(1);const selection={selectedContactId:id,scopeRevision:1,directoryPhase:'ready',contacts:[{contactId:id,displayName:'合成联系人'}]};
 const contacts={getState:()=>selection,onStateChanged:()=>()=>{}};
 const status=view(id);
 const backend={getConnectionGeneration:()=>1,onStateChanged:()=>()=>{},requestJson:async request=>{
  if(request.path.endsWith('/clear'))return {generation:1,data:{contact_id:id,phase:'none',completed:false,boundary:null,boundary_pending:false,failure_code:null,boundary_reason:null,stored_messages:3,stored_sources:1,open_goals:0}};
  if(request.path.endsWith('/resync'))return {generation:1,data:{contact_id:id,request_key:null,state:'none',completed:false,goal:null}};
  return {generation:1,data:status};
 }};
 const controller=new ports.HistoryClearController(backend,contacts,activity);
 return {controller,scope:{contactId:id,scopeRevision:1}};
}
