/** 真实租约与事务返回屏障；不访问运行管理器的私有占用状态。 */
import type {Context} from '@deepseek-ai/cordis';
import type {Client} from 'pg';
import type {HostStorage} from '../src/platform/database/host-storage.ts';
import {AssistantRuntime,type AssistantRuntimeLease} from '../src/reply/runtime/assistant-runtime.ts';
import {AssistantRuntimeProjection} from '../src/reply/runtime/assistant-runtime-projection.ts';

export async function runtimeHistoryReleaseRace(ctx:Context,storage:HostStorage,home:string,skillsRoot:string,owner:string,key:string){
 const turn=await storage.businessTransaction(async client=>(await client.query(`SELECT turn.*,runtime.configuration_sha256,runtime.committed_event_count
  FROM assistant_session_turn turn JOIN assistant_runtime_session runtime ON runtime.owner_id=turn.owner_id AND runtime.contact_id=turn.contact_id AND runtime.session_id=turn.session_id
  WHERE turn.owner_id=$1 AND turn.idempotency_key=$2 AND runtime.state='ready'`,[owner,key])).rows[0]);
 if(!turn?.reply_request_id)throw Error('合成已提交运行准备失败');
 const scope={owner_id:owner,contact_id:turn.contact_id,conversation_binding_id:turn.conversation_binding_id,confirmation:'manual' as const};
 let lease:AssistantRuntimeLease|null=null,armed=false,releasedAtBoundary=false;
 const transaction=async<T>(work:(client:Client)=>Promise<T>):Promise<T>=>{
  try{return await storage.businessTransaction(work);}
  finally{if(armed){armed=false;await lease!.release();releasedAtBoundary=true;
   await storage.businessTransaction(client=>client.query("UPDATE assistant_session_turn SET state='redacted',input_payload=NULL,input_digest=NULL,reply_request_id=NULL,dependency_ids='{}' WHERE owner_id=$1 AND contact_id=$2 AND id=$3",[owner,turn.contact_id,turn.id]));
  }}
 };
 const runtime=new AssistantRuntime({ctx,transaction,home});
 try{
  lease=await runtime.acquire(scope,key,turn.reply_request_id,turn.configuration_sha256);if(!lease)throw Error('合成真实租约不可用');
  const projection=new AssistantRuntimeProjection(skillsRoot);
  await lease.commit(turn.committed_event_count,client=>projection.read(client,scope,turn.session_id,scope.conversation_binding_id,key));
  armed=true;let rejected=false,code:string|undefined,historyReturned=false;
  try{historyReturned=(await runtime.history(scope,key,turn.configuration_sha256))!==null;}catch(error){rejected=true;code=(error as {code?:string}).code;}
  const after=await runtime.history(scope,key,turn.configuration_sha256);
  const state=await storage.businessTransaction(async client=>(await client.query('SELECT state FROM assistant_runtime_session WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3',[owner,turn.contact_id,turn.session_id])).rows[0]?.state);
  return {rejected,code,historyReturned,releasedAtBoundary,historyAvailableAfter:after!==null,state};
 }finally{armed=false;await lease?.release();}
}
