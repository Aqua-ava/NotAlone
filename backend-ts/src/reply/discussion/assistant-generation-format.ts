/** 旧准备格式沿原租约门禁封键；不重建旧材料、不覆盖已保存候选。 */
import type {Client} from 'pg';
import type {VerifiedReplyScope} from '../generation/reply-scope.ts';
import {decodePreparedContext} from '../generation/reply-prepared-codec.ts';
import {parseJson} from '../../host/host-json.ts';
import {validatePreferenceSnapshot} from '../../preferences/preference-service.ts';
import {AssistantGenerationStore,AssistantGenerationError,generationRequest,matchesGenerationSession,generationReject,generationReceipt,type GenerationRow} from './assistant-generation-store.ts';
export async function requireGenerationInput(store:AssistantGenerationStore,client:Client,scope:VerifiedReplyScope,session:string,key:string,inputVersion?:string):Promise<GenerationRow>{
 await store.session(client,scope,session);const row=await store.existing(client,scope,key);
 if(!row||!matchesGenerationSession(row,session))throw new AssistantGenerationError('not_found',undefined,404);
 session=row.session_id;
 if(inputVersion&&row.input_version_id!==inputVersion)generationReject('input_version_stale');
 const input=(await client.query("SELECT * FROM assistant_session_input WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND id=$4 AND turn_id=$5 AND input_type='generation'",[scope.owner_id,scope.contact_id,session,row.input_version_id,row.id])).rows[0];
 if(!input)generationReject('input_version_stale');if(row.state==='redacted'||input.state==='redacted'||row.input_payload===null)generationReject('source_deleted');
 if(input.conversation_binding_id!==row.conversation_binding_id||row.conversation_binding_id!==scope.conversation_binding_id)generationReject('binding_changed');
 await store.guards.assistant.verifiedDiscussionDependencies(client,scope,[...new Set([...row.dependency_ids,...input.dependency_ids])],true);return row;
}
export async function checkGenerationFormat(store:AssistantGenerationStore,client:Client,scope:VerifiedReplyScope,session:string,key:string,inputVersion?:string){
 let row=await store.existing(client,scope,key);if(!row)return null;
 row=await requireGenerationInput(store,client,scope,session,key,inputVersion);
 if(row.prepared_context===null)return {...generationReceipt(row),format_status:'compatible'};
 let incompatible=false;
 try{
  const auth=await store.auth(client,scope,row.requested_session_id??row.session_id,row.input_payload),input=generationRequest(scope,key,row.input_payload,auth),raw=(await client.query('SELECT prepared_context::text AS value FROM assistant_session_turn WHERE id=$1',[row.id])).rows[0].value;
  const context=decodePreparedContext(parseJson(raw),input,{owner_id:scope.owner_id,contact_id:scope.contact_id},row.conversation_binding_id);
  const revision=String((await client.query('SELECT revision FROM skill_library WHERE owner_id=$1',[scope.owner_id])).rows[0]?.revision??0);
  if(String(context.skill_library_revision)!==revision)incompatible=true;
  if(context.expression_preference_revision!==null)await validatePreferenceSnapshot(client,scope.owner_id,scope.contact_id,input.content.type,{revision:context.expression_preference_revision,preferences:context.expression_preferences.map((preference:GenerationRow)=>{const {scope:oldScope,origin_kind,origin_id,...rest}=preference;const {owner_id:_,...scope}=oldScope;return {...rest,scope,origin:origin_id?{kind:origin_kind,id:origin_id}:{kind:origin_kind}};})});
 }catch{incompatible=true;}
 if(!incompatible)return {...generationReceipt(row),format_status:'compatible'};
 const request=(await client.query('SELECT * FROM reply_request WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3 FOR UPDATE',[scope.owner_id,scope.contact_id,key])).rows[0];
 if(!request&&(row.reply_request_id!==null||row.state==='completed'))return {...generationReceipt(row),format_status:'generation_unconfirmed'};
 if(request){
  if(request.conversation_binding_id!==row.conversation_binding_id||row.reply_request_id!==null&&row.reply_request_id!==request.id)return {...generationReceipt(row),format_status:'generation_unconfirmed'};
  await store.guards.ports.requireReplySourcesCurrent(client,scope,request.id,true);
  const attempts=(await client.query('SELECT number,state FROM reply_attempt WHERE reply_request_id=$1 ORDER BY number FOR UPDATE',[request.id])).rows;
  if(attempts.some(a=>a.state==='running'))return {...generationReceipt(row),format_status:'generation_running'};
  const latest=attempts.find(a=>a.number===request.attempt),allowed:GenerationRow={completed:['completed'],failed:['failed','expired'],expired:['expired']};
  if(!latest||attempts.some(a=>a.number>request.attempt)||!allowed[request.state]?.includes(latest.state))return {...generationReceipt(row),format_status:'generation_unconfirmed'};
  if(request.state==='completed'){await store.guards.ports.requireSavedSkillPolicy(client,scope,request.id);await client.query("UPDATE assistant_session_turn SET state='completed',reply_request_id=$2,interruption_reason=NULL,updated_at=now() WHERE id=$1",[row.id,request.id]);return {...generationReceipt({...row,state:'completed'}),format_status:'compatible'};}
 }
 await client.query('INSERT INTO reply_invalidated_key(owner_id,contact_id,idempotency_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[scope.owner_id,scope.contact_id,key]);
 await client.query("UPDATE assistant_session_turn SET state='failed',updated_at=now() WHERE id=$1 AND state IN ('running','failed')",[row.id]);
 return {...generationReceipt({...row,state:row.state==='running'?'failed':row.state}),format_status:'reprepare_required'};
}
