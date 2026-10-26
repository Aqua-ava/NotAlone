/** 已保存候选沿原版本/原场景复验执行视图；不把当前目录替代历史凭证。 */
import type {Client} from 'pg';
import {SkillFiles,SkillFileError} from '../../skills/skill-files.ts';
import {selectMethods,skillDigest,SkillPortError,FILTERED_DESCRIPTION} from '../../skills/skill-execution-view.ts';
import {requireVersionSources,type SkillDiscussionValidator} from '../../skills/skill-source-proof.ts';
import {snapshot as parseDiscussion,carryEdges,AssistantErasureError} from './reply-assistant-erasure.ts';
import {ReplyStoreError} from './reply-store.ts';
import type {AssistantScope} from './reply-assistant-guards.ts';
type Row=Record<string,any>;
const object=(v:unknown):v is Row=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validView(v:unknown):v is Row {
 return object(v)&&Object.keys(v).sort().join(',')==='method_ids,policy_revision,sha256'&&Number.isSafeInteger(v.policy_revision)&&v.policy_revision>=0&&Array.isArray(v.method_ids)&&v.method_ids.every((id:unknown)=>typeof id==='string'&&uuid.test(id))&&new Set(v.method_ids).size===v.method_ids.length&&typeof v.sha256==='string'&&/^[a-f0-9]{64}$/.test(v.sha256);
}
export function createReplySkillGuards(options:{files:SkillFiles;requireDiscussionDependencies?:SkillDiscussionValidator}) {
 async function ownChange(client:Client,scope:AssistantScope,requestId:string):Promise<string|null> {
  const row=(await client.query(`SELECT version.*,request.skill_version_id,request.context_snapshot,request.normalized_input,
    request.idempotency_key,request.conversation_binding_id,skill.owner_id,skill.name,skill.status AS skill_status,
    skill.id AS skill_id,skill.contact_id
    FROM reply_request request LEFT JOIN reply_skill skill ON skill.id=request.skill_id AND skill.owner_id=request.owner_id
    LEFT JOIN reply_skill_version version ON version.id=request.skill_version_id AND version.skill_id=skill.id
    WHERE request.owner_id=$1 AND request.contact_id=$2 AND request.id=$3 AND request.skill_version_id IS NOT NULL`,[scope.owner_id,scope.contact_id,requestId])).rows[0];
  if(!row)return null;
  const version=row.skill_version_id;
  if(!row.skill_id||!row.content_path||row.skill_status!=='active')return version;
  try {
   const frozen=row.context_snapshot;
   if(!object(frozen)||typeof row.normalized_input!=='string')return version;
   let scene:unknown;
   if(row.normalized_input.startsWith('suggestion-sha256:')) {
    const turn=(await client.query('SELECT input_payload FROM assistant_session_turn WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3 AND conversation_binding_id=$4',[scope.owner_id,scope.contact_id,row.idempotency_key,row.conversation_binding_id])).rows[0];
    if(!object(turn?.input_payload))return version;scene=turn.input_payload.scene??null;
   } else {
    const command:unknown=JSON.parse(row.normalized_input);
    if(!object(command)||!['reply_to_message','initiate_conversation','rewrite_draft'].includes(command.mode))return version;
    scene=command.scene??null;
   }
   if(scene!==null&&(typeof scene!=='string'||!scene.trim()||scene!==scene.trim()||[...scene].length>256))return version;
   if(Object.hasOwn(frozen,'skill_execution_scene')&&frozen.skill_execution_scene!==scene)return version;
   await requireVersionSources(client,scope.owner_id,version,scope.contact_id,options.requireDiscussionDependencies);
   options.files.readManifest(row); // 只核原不可变manifest，不扫描/同步当前工作目录。
   const original=options.files.readContent(row);
   const selection=await selectMethods(client,{ownerId:scope.owner_id,contactId:scope.contact_id,scene:scene as string??''},row);
   const document=selection.filtered?'---\nname: '+row.name+'\ndescription: '+JSON.stringify(FILTERED_DESCRIPTION)+'\n---\n# 本次允许的方法\n\n'+options.files.readMethods(row,selection.ordered,selection.allowed).map(m=>'## '+m.title+'\n'+m.instruction).join('\n\n'):original;
   const current={policy_revision:selection.policyRevision,method_ids:selection.allowed,sha256:skillDigest({version_id:row.id,document,methods:selection.allowed,policies:selection.policies.map(p=>[p.id,p.revision])})};
   if(!Object.hasOwn(frozen,'skill_execution_view'))return current.policy_revision===0?null:version;
   const saved=frozen.skill_execution_view;
   if(validView(saved)&&skillDigest({...saved,method_ids:saved.method_ids.map((id:string)=>id.toLowerCase())})===skillDigest(current))return null;
  } catch(error) {
   if(!(error instanceof SkillFileError||error instanceof SkillPortError||error instanceof SyntaxError||error instanceof TypeError))throw error;
  }
  return version;
 }
 async function savedSkillPolicyChange(client:Client,scope:AssistantScope,requestId:string):Promise<string|null> {
  const pending=new Set([requestId]),seen=new Set<string>();
  while(pending.size) {
   const current=pending.values().next().value!;pending.delete(current);if(seen.has(current))continue;seen.add(current);
   if(seen.size>256)return requestId;
   const change=await ownChange(client,scope,current);if(change)return change;
   const row=(await client.query('SELECT context_snapshot,continued_from_candidate_id,idempotency_key FROM reply_request WHERE id=$1 AND owner_id=$2 AND contact_id=$3',[current,scope.owner_id,scope.contact_id])).rows[0];
   if(!row)continue;
   const candidates=new Set<string>(row.continued_from_candidate_id?[row.continued_from_candidate_id]:[]),payload=row.context_snapshot??{};
   if(!object(payload))return requestId;
   if(Object.hasOwn(payload,'assistant_discussion_snapshot')) {
    try {
     const discussion=parseDiscussion(payload.assistant_discussion_snapshot,scope.owner_id,scope.contact_id,row.idempotency_key);
     for(const record of discussion.records)if(record.kind==='candidate_version')candidates.add(record.candidate_id);
     const inputs=discussion.records.filter((r:Row)=>r.kind==='discussion_input').map((r:Row)=>r.input_version_id);
     for(const input of (await client.query("SELECT id,content FROM assistant_session_input WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[]) AND input_type='candidate_carry'",[scope.owner_id,scope.contact_id,inputs])).rows) {
      const edges=await carryEdges(client,scope.owner_id,input.id);
      if(edges.length!==1||edges[0].contact!==scope.contact_id)return requestId;
      pending.add(input.content.origin_reply_request_id);
     }
    } catch(error) {if(error instanceof AssistantErasureError||error instanceof TypeError||error instanceof SyntaxError)return requestId;throw error;}
   }
   if(candidates.size)for(const parent of (await client.query('SELECT reply_request_id FROM reply_candidate WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[])',[scope.owner_id,scope.contact_id,[...candidates]])).rows)pending.add(parent.reply_request_id);
  }
  return null;
 }
 async function requireSavedSkillPolicy(client:Client,scope:AssistantScope,requestId:string):Promise<void> {
  if(await savedSkillPolicyChange(client,scope,requestId)!==null)throw new ReplyStoreError('reply_input_invalidated');
 }
 return {requireSavedSkillPolicy,savedSkillPolicyChange};
}
