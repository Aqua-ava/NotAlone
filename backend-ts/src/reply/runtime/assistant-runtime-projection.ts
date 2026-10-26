import {decodePreparedContext,PreparedContextFormatError} from '../generation/reply-prepared-codec.ts';
import {requireLayeredMaterial,CONTACT_LAYERED_BUDGET,OWNER_LAYERED_BUDGET} from '../context/reply-context-layered.ts';
/** 业务讨论的零模型投影；不把数据库历史冒充从未保存的 SDK 执行日志。 */
import type {Client} from 'pg';
import type {AssistantScope} from '../generation/reply-assistant-guards.ts';
import {createReplyAssistantGuards} from '../generation/reply-assistant-factory.ts';
import {createReplySkillGuards} from '../generation/reply-skill-guards.ts';
import {PostgresReplyDiscussionContext,DISCUSSION_NOTICE} from '../discussion/reply-discussion-context.ts';
import {SkillFiles,SkillFileError} from '../../skills/skill-files.ts';
import {fingerprint} from '../generation/reply-assistant-erasure.ts';
import {readContextMessages} from '../context/reply-context-read.ts';
import {requireCurrentReplyMemory} from '../context/reply-context-guards.ts';
import {allowsHistory,recentOnly} from '../context/reply-context.ts';
import type {ReplyRequestInput} from '../generation/reply-contract.ts';
import {ReplyStoreError} from '../generation/reply-store.ts';
export interface AssistantRuntimePlan {
 scope:AssistantScope;session_id:string;binding_id:string;
 qualification:{version:1;scope:AssistantScope;contract:string;policy:AssistantRuntimePolicy;binding_id:string;records:Record<string,string>;inventory:Record<string,string>;payload_sha256:string};
 payload:unknown;
}
export interface AssistantRuntimePolicy {relationship:boolean;recent_only:boolean;excluded_message_ids:string[];history_message_ids:string[]|null;skill_disabled:boolean;scene:string|null;skill_version_id:string|null}
export function assistantRuntimePolicy(input:ReplyRequestInput,historyIds?:string[]|null):AssistantRuntimePolicy{return {relationship:allowsHistory(input),recent_only:recentOnly(input),excluded_message_ids:[...input.content.excluded_message_ids as string[]??[]].sort(),history_message_ids:historyIds?[...historyIds].sort():null,skill_disabled:input.skill_disabled,scene:input.scene,skill_version_id:input.skill_version_id};}
export type AssistantRuntimePlanReader=(client:Client)=>Promise<AssistantRuntimePlan>;
export class AssistantRuntimeProjection {
 private readonly files:SkillFiles;
 constructor(skillsRoot:string){this.files=new SkillFiles(skillsRoot);}
 async read(client:Client,scope:AssistantScope,sessionId:string,binding:string,excludeRequestKey?:string,requestedPolicy?:AssistantRuntimePolicy):Promise<AssistantRuntimePlan>{
  const stored=(await client.query('SELECT qualification FROM assistant_runtime_session WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3',[scope.owner_id,scope.contact_id,sessionId])).rows[0]?.qualification;
  const policy:AssistantRuntimePolicy=requestedPolicy??stored?.policy??{relationship:true,recent_only:false,excluded_message_ids:[],history_message_ids:null,skill_disabled:false,scene:null,skill_version_id:null};
  const savedSkill=createReplySkillGuards({files:this.files,requireDiscussionDependencies:async(c,owner,contact,id)=>{const ids=await assistant.requireReplyDiscussionById(c,{owner_id:owner,contact_id:contact},id);if(ids===null)throw new ReplyStoreError('reply_context_invalidated');return ids;}});
  const {assistant,ports}=createReplyAssistantGuards(savedSkill,async(c,s)=>{
   const valid=await c.query(`SELECT id FROM manual_contact_confirmation WHERE owner_id=$1 AND contact_id=$2 AND id=$3
    UNION ALL SELECT id FROM conversation_binding WHERE owner_id=$1 AND contact_id=$2 AND id=$3 AND status='active'`,[s.owner_id,s.contact_id,binding]);
   if(valid.rowCount!==1)throw new ReplyStoreError('reply_context_invalidated');return binding;
  });
  const discussion=new PostgresReplyDiscussionContext({guards:assistant,ports,requireRuntimeMaterials:async(c,s,row)=>{
   if(!row.reply_request_id)return;
   const request=(await c.query('SELECT context_snapshot,skill_version_id,skill_loaded_resources FROM reply_request WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[s.owner_id,s.contact_id,row.reply_request_id])).rows[0],snapshot=request?.context_snapshot;
   if(!snapshot||!Array.isArray(snapshot.evidence))throw new ReplyStoreError('reply_context_invalidated');
   if(request.skill_version_id!==null&&(policy.skill_disabled||policy.skill_version_id!==null&&request.skill_version_id!==policy.skill_version_id||(snapshot.skill_execution_scene??null)!==policy.scene))throw new ReplyStoreError('reply_context_invalidated');
   if(!policy.relationship&&(snapshot.evidence.some((e:Record<string,any>)=>['message','confirmed_memory','pending_candidate','owner_memory'].includes(e.kind))||snapshot.layered_context||snapshot.owner_layered_context))throw new ReplyStoreError('reply_context_invalidated');
   if(snapshot.evidence.some((e:Record<string,any>)=>e.kind==='message'&&(policy.recent_only||policy.excluded_message_ids.includes(e.evidence_id)||policy.history_message_ids!==null&&!policy.history_message_ids.includes(e.evidence_id))))throw new ReplyStoreError('reply_context_invalidated');
   await requireCurrentReplyMemory(c,s,snapshot.evidence);
   const library=String((await c.query('SELECT revision FROM skill_library WHERE owner_id=$1',[s.owner_id])).rows[0]?.revision??0);
   if(String(snapshot.skill_library_revision??0)!==library)throw new ReplyStoreError('reply_context_invalidated');
   for(const p of snapshot.expression_preferences??[]){
    const current=(await c.query("SELECT text_content,revision,contact_id,reply_mode FROM expression_preference WHERE owner_id=$1 AND id=$2 AND status='active'",[s.owner_id,p.preference_id])).rows[0];
    if(!current||current.text_content!==p.text||String(current.revision)!==String(p.revision)||current.contact_id!==(p.scope?.contact_id??null)||current.reply_mode!==(p.scope?.reply_mode??null))throw new ReplyStoreError('reply_context_invalidated');
   }
   if(snapshot.layered_context||snapshot.owner_layered_context){
    const turn=(await c.query('SELECT idempotency_key,prepared_context FROM assistant_session_turn WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[s.owner_id,s.contact_id,row.turn_id])).rows[0];
    if(!turn?.prepared_context)throw new ReplyStoreError('reply_context_invalidated');
    try{
     const command={...row.input_payload,contact_id:s.contact_id,idempotency_key:turn.idempotency_key,continued_from_candidate_id:row.input_payload.continued_from_candidate_id??null} as ReplyRequestInput;
     const prepared=decodePreparedContext(turn.prepared_context,command,s,row.conversation_binding_id,row.reply_request_id);
     await requireLayeredMaterial(c,s,prepared.layered_context,CONTACT_LAYERED_BUDGET);
     await requireLayeredMaterial(c,{owner_id:s.owner_id,contact_id:null},prepared.owner_layered_context,OWNER_LAYERED_BUDGET);
    }catch(error){if(error instanceof PreparedContextFormatError)throw new ReplyStoreError('reply_context_invalidated');throw error;}
   }
   if(request.skill_version_id){
    const version=(await c.query('SELECT version.*,skill.owner_id,skill.name FROM reply_skill_version version JOIN reply_skill skill ON skill.id=version.skill_id WHERE skill.owner_id=$1 AND version.id=$2',[s.owner_id,request.skill_version_id])).rows[0];
    if(!version)throw new ReplyStoreError('reply_context_invalidated');
    try{for(const path of request.skill_loaded_resources??[])this.files.readResource(version,path);}catch(error){if(error instanceof SkillFileError)throw new ReplyStoreError('reply_context_invalidated');throw error;}
   }
   const messages=snapshot.evidence.filter((e:Record<string,any>)=>e.kind==='message');
   const current=await readContextMessages(c,s,{ids:messages.map((e:Record<string,any>)=>e.evidence_id),limit:Math.max(1,messages.length)});
   for(const old of messages){const actual=current.find(e=>e.evidence_id===old.evidence_id);if(!actual||['text','speaker_role','source_ids','timing','freshness_sha256'].some(field=>old[field]!==undefined&&fingerprint(old[field])!==fingerprint(actual[field as keyof typeof actual])))throw new ReplyStoreError('reply_context_invalidated');}
  }});
  const projection=await discussion.readSession(client,scope,sessionId,binding,excludeRequestKey);
  const records=Object.fromEntries(projection.items.map(i=>[`${i.kind}:${i.input_version_id}:${i.version_id??''}`,fingerprint(i)]));
  const inventory=await this.inventory(client,scope);
  const payload={session_id:sessionId,origin:'business_records',factual_role:'assistant_discussion_reference',weight:'low',notice:DISCUSSION_NOTICE,items:projection.items.map(i=>({...i,role:i.kind==='candidate_version'||i.kind==='candidate_carry'?'assistant_candidate':'user',is_sent:false}))};
  return {scope:{...scope},session_id:sessionId,binding_id:binding,qualification:{version:1,scope:{...scope},contract:'notalone-reply:fidelity-v3:bounded-tools-v1:business-reference-v1',policy,binding_id:binding,records,inventory,payload_sha256:fingerprint(payload)},payload};
 }
 private async inventory(client:Client,scope:AssistantScope):Promise<Record<string,string>>{
  // 覆盖提示、未引用的背景、工具可读层与目录；只落无正文指纹，不靠最终候选引用缩小资格。
  const contactTables=['message','message_source_ref','source_document','confirmed_memory','memory_candidate','contact_memory_state','contact_memory_index'];
  const sharedTables=['expression_preference','scenario_document_version','layered_profile_version','layered_memory_state','skill_scope_policy','reply_skill'];
  const ownerTables=['owner_memory','owner_memory_state','skill_library'];
  const inventory:Record<string,string>={};
  for(const [tables,predicate] of [[contactTables,'owner_id=$1 AND contact_id=$2'],[sharedTables,'owner_id=$1 AND (contact_id IS NULL OR contact_id=$2)'],[ownerTables,'owner_id=$1']] as const){
   for(const table of tables){const rows=(await client.query(`SELECT coalesce(to_jsonb(t)->>'id',concat_ws(':',to_jsonb(t)->>'owner_id',to_jsonb(t)->>'contact_id')) AS key,encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS digest FROM public.${table} t WHERE ${predicate}`,predicate.includes('$2')?[scope.owner_id,scope.contact_id]:[scope.owner_id])).rows;for(const row of rows)inventory[table+':'+row.key]=row.digest;}
  }
  for(const row of (await client.query(`SELECT version.*,skill.owner_id,skill.name,skill.id AS skill_id FROM reply_skill_version version JOIN reply_skill skill ON skill.id=version.skill_id WHERE skill.owner_id=$1 AND (skill.contact_id IS NULL OR skill.contact_id=$2)`,[scope.owner_id,scope.contact_id])).rows)inventory['reply_skill_version:'+row.id]=fingerprint(row);
  return inventory;
 }
}
