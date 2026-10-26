/** 退出与启动恢复只裁定原业务身份；可靠候选先赢，不自动重放模型。 */
import type {Client} from 'pg';
import type {VerifiedReplyScope} from '../generation/reply-scope.ts';
import {generationDependencies} from '../generation/reply-assistant-erasure.ts';
import {requireGenerationInput} from './assistant-generation-format.ts';
import {AssistantGenerationStore,AssistantGenerationError,generationReceipt,generationReject} from './assistant-generation-store.ts';
export const interruptionReasons=['app_quit','configuration_reload','user_cancelled'] as const;
export async function interruptAssistantGeneration(store:AssistantGenerationStore,client:Client,scope:VerifiedReplyScope,session:string,key:string,inputVersion:string,reason:string){
 if(!(interruptionReasons as readonly string[]).includes(reason))throw new AssistantGenerationError('assistant_session_request_invalid',undefined,400);
 const row=await requireGenerationInput(store,client,scope,session,key,inputVersion);
 const request=(await client.query('SELECT * FROM reply_request WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3 FOR UPDATE',[scope.owner_id,scope.contact_id,key])).rows[0];
 if(request){if(request.conversation_binding_id!==row.conversation_binding_id||row.reply_request_id!==null&&row.reply_request_id!==request.id)generationReject('binding_changed');await store.guards.ports.requireReplySourcesCurrent(client,scope,request.id,true);}
 const receipt=(value:typeof row)=>({...generationReceipt(value),interruption_reason:value.state==='failed'?value.interruption_reason:null});
 if(request?.state==='completed'){
  if(row.interruption_reason!==null)generationReject('generation_interrupted');await store.guards.ports.requireSavedSkillPolicy(client,scope,request.id);
  const deps=[...new Set([...row.dependency_ids,...await generationDependencies(client,scope.owner_id,scope.contact_id,{turn_dependencies:[],reply_request_id:request.id})])];await store.guards.assistant.verifiedDiscussionDependencies(client,scope,deps,true);
  await client.query("UPDATE assistant_session_turn SET state='completed',reply_request_id=$2,dependency_ids=$3,interruption_reason=NULL,updated_at=now() WHERE id=$1",[row.id,request.id,deps]);return receipt({...row,state:'completed'});
 }
 const invalidated=(await client.query('SELECT 1 FROM reply_invalidated_key WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3',[scope.owner_id,scope.contact_id,key])).rowCount;
 const attempts=request?(await client.query('SELECT * FROM reply_attempt WHERE reply_request_id=$1 ORDER BY number FOR UPDATE',[request.id])).rows:[];
 const latest=request?attempts.find(a=>a.number===request.attempt):undefined;
 if(row.interruption_reason!==null){
  if(!interruptionReasons.includes(row.interruption_reason)||row.state!=='failed'||!invalidated||request&&(request.state!=='failed'||!latest||latest.state!=='failed'||latest.failure_reason!==row.interruption_reason||attempts.some(a=>a.state==='running')))throw new AssistantGenerationError('assistant_session_save_failed',undefined,503);
  return receipt(row);
 }
 if(row.state==='failed'&&!request){await client.query('INSERT INTO reply_invalidated_key(owner_id,contact_id,idempotency_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[scope.owner_id,scope.contact_id,key]);return receipt(row);}
 if(row.state==='failed'&&request?.state==='failed'){
  if(!latest||!['failed','expired'].includes(latest.state)||interruptionReasons.includes(latest.failure_reason)||attempts.some(a=>a.state==='running'))throw new AssistantGenerationError('assistant_session_save_failed',undefined,503);return receipt(row);
 }
 if(invalidated)generationReject('request_deleted');
 if(!['running','failed'].includes(row.state)||request&&request.state!=='running')generationReject('generation_not_running');
 await client.query('INSERT INTO reply_invalidated_key(owner_id,contact_id,idempotency_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[scope.owner_id,scope.contact_id,key]);
 if(request){
  await client.query("UPDATE reply_request SET state='failed',lease_expires_at=least(lease_expires_at,now()),updated_at=now() WHERE id=$1",[request.id]);
  const changed=await client.query("UPDATE reply_attempt SET state='failed',failure_reason=$3,lease_expires_at=least(lease_expires_at,now()) WHERE reply_request_id=$1 AND number=$2 AND state='running'",[request.id,request.attempt,reason]);if(changed.rowCount!==1)throw new AssistantGenerationError('assistant_session_save_failed',undefined,503);
 }
 await client.query("UPDATE assistant_session_turn SET state='failed',interruption_reason=$2,updated_at=now() WHERE id=$1",[row.id,reason]);return receipt({...row,state:'failed',interruption_reason:reason});
}
