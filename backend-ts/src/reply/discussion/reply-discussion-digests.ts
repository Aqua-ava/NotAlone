/** 运行资格只搬运数据库端正文摘要；完整业务引用由显式构建路径读取。 */
import type {Client} from 'pg';
import type {AssistantScope} from '../generation/reply-assistant-guards.ts';
import {legacyJson} from '../generation/reply-assistant-erasure.ts';
export async function discussionInspectionRows(client:Client,scope:AssistantScope,session:string):Promise<Record<string,any>[]>{
 const rows=(await client.query(`SELECT input.id,input.session_id,input.turn_id,input.input_type,input.state,input.conversation_binding_id,input.dependency_ids,
  input.content IS NOT NULL AS content_present,CASE WHEN input.input_type='candidate_carry' THEN input.content::text END AS content_text,
  turn.state AS turn_state,turn.input_payload IS NOT NULL AS input_payload_present,turn.dependency_ids AS turn_dependencies,
  request.id AS reply_request_id,request.state AS request_state,
  encode(sha256(convert_to(jsonb_build_array(input.content,input.conversation_binding_id,input.dependency_ids,
  turn.input_payload,turn.input_digest,turn.dependency_ids,request.id)::text,'UTF8')),'hex') AS record_digest
  FROM assistant_session_input input LEFT JOIN assistant_session_turn turn ON turn.id=input.turn_id AND turn.input_version_id=input.id
   AND turn.owner_id=input.owner_id AND turn.contact_id=input.contact_id AND turn.session_id=input.session_id
  LEFT JOIN reply_request request ON (turn.reply_request_id IS NULL OR request.id=turn.reply_request_id) AND request.owner_id=turn.owner_id
   AND request.contact_id=turn.contact_id AND request.conversation_binding_id=turn.conversation_binding_id AND request.idempotency_key=turn.idempotency_key
  WHERE input.owner_id=$1 AND input.contact_id=$2 AND input.session_id=$3 ORDER BY input.created_at,coalesce(input.turn_id,input.id)`,[scope.owner_id,scope.contact_id,session])).rows;
 return rows.map(row=>({...row,content:legacyJson(row.content_text)}));
}
export async function discussionVersionDigests(client:Client,scope:AssistantScope,row:Record<string,any>):Promise<{id:string;digest:string}[]>{
 return (await client.query(`SELECT version.id,encode(sha256(convert_to(jsonb_build_array(candidate.id,version.id,version.version_number,
  version.parent_version_id,version.requirements,CASE WHEN version.version_number=0 THEN candidate.message_group ELSE version.message_group END,
  candidate.ordinal,candidate.reply_request_id)::text,'UTF8')),'hex') AS digest
  FROM reply_candidate candidate JOIN reply_request request ON request.id=candidate.reply_request_id AND request.owner_id=candidate.owner_id
   AND request.contact_id=candidate.contact_id AND request.conversation_binding_id=candidate.conversation_binding_id
  CROSS JOIN LATERAL (
   SELECT id,version_number,parent_version_id,requirements,message_group FROM assistant_candidate_version
    WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND turn_id=$4 AND candidate_id=candidate.id
   UNION ALL SELECT candidate.id,0,NULL::uuid,NULL::text,NULL::jsonb WHERE NOT EXISTS (
    SELECT 1 FROM assistant_candidate_version WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND turn_id=$4 AND candidate_id=candidate.id AND version_number=0)
  ) version
  WHERE candidate.owner_id=$1 AND candidate.contact_id=$2 AND candidate.reply_request_id=$5 AND candidate.conversation_binding_id=$6
   AND NOT EXISTS(SELECT 1 FROM reply_invalidated_key k WHERE k.owner_id=request.owner_id AND k.contact_id=request.contact_id AND k.idempotency_key=request.idempotency_key)
  ORDER BY candidate.ordinal,version.version_number`,[scope.owner_id,scope.contact_id,row.session_id,row.turn_id,row.reply_request_id,row.conversation_binding_id])).rows;
}
