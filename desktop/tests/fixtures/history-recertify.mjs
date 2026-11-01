import {build} from 'esbuild';
const compiled=await build({stdin:{contents:`export {HistoryClearController} from './src/main/history-clear/controller';export {installHistoryClearBridge} from './src/main/history-clear/bridge';export {coordinateHistoryRecertification} from './src/main/history-clear/recertify-coordinator';export {createHistoryClearBridge} from './src/preload/history-clear';export {BackendRequestFailure} from './src/main/backend/json-client';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
export const ports=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
export const contact='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
export const recertifyStatus=(overrides={})=>({contact_id:contact,request_key:null,state:'none',stage:'none',completed:false,failure_code:null,message_count:0,non_text_count:0,page_count:0,preserved_message_count:0,started_at:null,finished_at:null,...overrides});
export const completedStatus=key=>recertifyStatus({request_key:key,state:'completed',stage:'completed',completed:true,message_count:4,non_text_count:1,page_count:2,preserved_message_count:7,started_at:100,finished_at:200});
export async function until(predicate){for(let attempt=0;attempt<80;attempt++){if(predicate())return;await new Promise(setImmediate);}throw Error('合成认证状态等待超时');}
export async function recertifyFixture(t){
 const calls=[],listeners=new Set(),backendListeners=new Set(),controls={status:recertifyStatus(),post:null,cancel:null,statuses:new Map()};
 const selection={selectedContactId:contact,scopeRevision:7,directoryPhase:'ready',contacts:[{contactId:contact,displayName:'合成联系人'},{contactId:other,displayName:'合成另一位'}]};
 const contacts={getState:()=>selection,onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}};
 const backend={getConnectionGeneration:()=>1,onStateChanged:fn=>{backendListeners.add(fn);return()=>backendListeners.delete(fn);},requestJson:async request=>{
  calls.push(request);const url=new URL(request.path,'http://synthetic.local'),id=url.pathname.split('/')[3];
  if(url.pathname.endsWith('/recertify/cancel')){
   if(controls.cancel)return controls.cancel(request);
   const status=recertifyStatus({contact_id:id,request_key:request.body.request_key,state:'interrupted',stage:'metadata',failure_code:'history_recertify_cancelled',started_at:100,finished_at:100});
   controls.statuses.set(request.body.request_key,status);controls.status=status;return {generation:1,data:status};
  }
  if(url.pathname.endsWith('/recertify')){
   if(request.method==='POST'){if(controls.post)return controls.post(request);controls.status=completedStatus(request.body.request_key);}
   const key=url.searchParams.get('request_key');
   return {generation:1,data:id!==contact?recertifyStatus({contact_id:id}):key?(controls.statuses.get(key)??(controls.status.request_key===key?controls.status:recertifyStatus())):controls.status};
  }
  if(request.path.endsWith('/clear'))return {generation:1,data:{contact_id:id,phase:'none',completed:false,boundary:null,boundary_pending:false,failure_code:null,boundary_reason:null,stored_messages:7,stored_sources:7,open_goals:0}};
  if(request.path.endsWith('/resync'))return {generation:1,data:{contact_id:id,request_key:null,state:'none',completed:false,goal:null}};
  throw Error('合成认证路由未知');
 }};
 const controller=new ports.HistoryClearController(backend,contacts);t.after(()=>controller.dispose());await until(()=>controller.getState().phase==='ready');
 return {controller,backend,contacts,calls,controls,selection,scope:{contactId:contact,scopeRevision:7},select(id){selection.selectedContactId=id;selection.scopeRevision++;for(const listener of listeners)listener(selection);}};
}
