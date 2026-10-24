import type {Client} from 'pg';
import {activeRef,digest} from './contact-overview-evidence.ts';
import {pythonISO} from './contact-overview-time.ts';
import {blankTiming,type ContextScope,type ReplyContextEvidence} from './reply-context-types.ts';
export async function readContextMessages(client:Client,scope:ContextScope,options:{ids?:string[]|null;target?:string;limit?:number}={}):Promise<ReplyContextEvidence[]>{
 const rows=(await client.query(`SELECT m.id,m.owner_id,m.contact_id,m.speaker,m.occurred_at::text,
  CASE WHEN length(btrim(m.text_content))>0 THEN m.text_content ELSE m.media_placeholder END AS text,
  (SELECT jsonb_agg(to_jsonb(ref) || jsonb_build_object('source_content_sha256',(SELECT s.content_sha256 FROM public.source_document s WHERE s.id=ref.source_document_id AND s.owner_id=ref.owner_id AND s.contact_id=ref.contact_id AND s.status='active')) ORDER BY ref.id) FROM public.message_source_ref ref WHERE ref.owner_id=m.owner_id AND ref.contact_id=m.contact_id AND ref.message_id=m.id AND ${activeRef}) AS refs
  FROM public.message m WHERE m.owner_id=$1 AND m.contact_id=$2 AND ($3::uuid[] IS NULL OR m.id=ANY($3::uuid[]))
   AND EXISTS(SELECT 1 FROM public.message_source_ref ref WHERE ref.owner_id=m.owner_id AND ref.contact_id=m.contact_id AND ref.message_id=m.id AND ${activeRef})
  ORDER BY (m.id=$4::uuid) DESC NULLS LAST,m.occurred_at DESC NULLS LAST,m.id DESC LIMIT $5`,[scope.owner_id,scope.contact_id,options.ids??null,options.target??null,options.limit??50])).rows;
 return rows.map(row=>{const time=pythonISO(row.occurred_at);return {evidence_id:row.id,kind:'message',text:row.text,scope,source_ids:[...new Set<string>(row.refs.map((ref:Record<string,any>)=>ref.source_document_id??ref.observation_id))],selection_reason:row.id===options.target?'待回复消息。':'同一联系人范围内的近期消息。',status:'active',valid_at:null,invalid_at:null,revision:null,timing:{...blankTiming(),source_started_at:time,source_ended_at:time,source_time_complete:time!==null},event:null,conditions:null,evolution:null,speaker_role:({user:'owner',contact:'contact',system:'system'} as const)[row.speaker as 'user'|'contact'|'system']??'unknown',model_visible:true,navigation:null,freshness_sha256:digest(row)};});
}
/** 可选资料失败保留显式回执；有外层事务时回到保存点，绝不吞掉中止事务。 */
export async function readOptionalContext<T>(client:Client,read:()=>Promise<T>):Promise<{value:T|null;failed:boolean}>{
 let savepoint=false;
 try{await client.query('SAVEPOINT reply_context_optional_read');savepoint=true;}catch(error){if((error as {code?:string}).code!=='25P01')throw error;}
 try{const value=await read();if(savepoint)await client.query('RELEASE SAVEPOINT reply_context_optional_read');return {value,failed:false};}
 catch(error){if(savepoint){await client.query('ROLLBACK TO SAVEPOINT reply_context_optional_read');await client.query('RELEASE SAVEPOINT reply_context_optional_read');}return {value:null,failed:true};}
}

export {selectReplyMessageWindow,requireReplyMessageWindowCount} from './reply-message-window.ts';
