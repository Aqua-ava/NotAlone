/** 已保存依据的公开投影；复用同事务来源／讨论／Skill资格，不重新检索。 */
import type {HostStorage} from './host-storage.ts';
import {ReplyStoreError,readStoredReplyResult} from './reply-store.ts';
import {createReplyAssistantGuards} from './reply-assistant-factory.ts';
import {createReplySkillGuards} from './reply-skill-guards.ts';
import {SkillFiles} from './skill-files.ts';
import {readReplyBasisChanges} from './reply-source-guards.ts';
import {projectReplyMemoryMetadata,type MemoryKind} from './reply-context-memory.ts';
import {parseJson} from './host-json.ts';
type Row=Record<string,any>;
const invalid=():never=>{throw new ReplyStoreError('reply_context_invalidated');};
function requireReceipt(receipt:Row|undefined,evidence:Row[]){
 const actual=new Map(evidence.map(item=>[item.evidence_id,item]));
 if(!receipt){if(evidence.some(item=>item.navigation))invalid();return;}
 if(receipt.version!==1||receipt.retriever_version!=='lexical-v1'||!Array.isArray(receipt.queries)||!receipt.budgets)invalid();
 for(const query of receipt.queries)if(!Array.isArray(query.evidence_ids)||query.evidence_ids.some((id:string)=>actual.get(id)?.kind!==query.kind))invalid();
 for(const [kind,key]of [['confirmed_memory','contact_memory'],['owner_memory','owner_memory'],['pending_candidate','pending_candidate']]){
  const items=evidence.filter(item=>item.kind===kind),budget=receipt.budgets[key];
  if(!budget||items.length!==budget.used_count||items.reduce((count,item)=>count+[...item.text].length,0)!==budget.used_chars)invalid();
 }
 for(const item of evidence)if(item.navigation){
  const navigation=item.navigation,revision=receipt.overview_revisions?.[navigation.scope_kind];
  if(!revision||navigation.memory_id!==item.evidence_id||navigation.memory_revision!==item.revision||navigation.projection_revision!==revision.projection_revision)invalid();
 }
}
export async function readPublicReplyEvidence(storage:HostStorage,skillsRoot:string,contact:string,request:string):Promise<{status:number;body:unknown}>{
 const owner=storage.runtimeOwnerId;if(!owner)return {status:503,body:{error:'owner_uninitialized'}};
 let failure:unknown;
 try{
  const body=await storage.businessTransaction(async client=>{
   try{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);
    const row=(await client.query('SELECT *,context_snapshot::text AS snapshot_text FROM reply_request WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[owner,contact,request])).rows[0];
    if(!row)throw new ReplyStoreError('reply_not_found');
    if((await client.query('SELECT 1 FROM reply_invalidated_key WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3',[owner,contact,row.idempotency_key])).rowCount)invalid();
    if(row.state!=='completed')throw new ReplyStoreError('reply_incomplete');
    const scope={owner_id:owner,contact_id:contact};
    const savedSkill=createReplySkillGuards({files:new SkillFiles(skillsRoot)});
    const {assistant,ports}=createReplyAssistantGuards(savedSkill,async()=>row.conversation_binding_id);
    await assistant.requireReplyDiscussionById(client,scope,request);
    await ports.requireReplySourcesCurrent(client,scope,request,true);
    await ports.requireSavedSkillPolicy(client,scope,request);
    const stored=await readStoredReplyResult(client,row),snapshot=parseJson(row.snapshot_text) as Row;
    const saved=(await client.query('SELECT evidence_id,kind,evidence_text AS text,selection_reason,evidence_status AS status FROM reply_context_evidence WHERE reply_request_id=$1 ORDER BY ordinal',[request])).rows;
    const original=Array.isArray(snapshot.evidence)?snapshot.evidence:[];
    if(original.length!==saved.length||saved.some(item=>!original.some((entry:Row)=>entry.evidence_id===item.evidence_id&&entry.kind===item.kind&&entry.text===item.text)))invalid();
    const evidence:Row[]=[];
    for(const entry of original){
     if(entry.model_visible===false)continue;
     const current={...entry};
     if(['confirmed_memory','owner_memory','pending_candidate'].includes(entry.kind)){
      const table=entry.kind==='pending_candidate'?'memory_candidate':entry.kind;
      const memory=(await client.query(`SELECT to_jsonb(memory) AS value FROM public.${table} memory WHERE owner_id=$1 AND id=$2 ${entry.kind==='owner_memory'?'':'AND contact_id=$3'}`,
       entry.kind==='owner_memory'?[owner,entry.evidence_id]:[owner,entry.evidence_id,contact])).rows[0]?.value;
      if(!memory)invalid();Object.assign(current,await projectReplyMemoryMetadata(client,memory,entry.kind as MemoryKind));
     }
     evidence.push(current);
    }
    requireReceipt(snapshot.retrieval,evidence);
    const cited=new Set(stored.candidates.flatMap(candidate=>candidate.citation_ids));
    const changes=await readReplyBasisChanges(client,scope,request,savedSkill.savedSkillPolicyChange);
    return {reply_request_id:request,candidate_output:stored.candidates,
     layered_context:snapshot.layered_context??null,layered_status:snapshot.layered_status??'quality_closed',
     owner_layered_context:snapshot.owner_layered_context??null,owner_layered_status:snapshot.owner_layered_status??'quality_closed',
     layered_scenario_reads:snapshot.layered_scenario_reads??[],owner_layered_scenario_reads:snapshot.owner_layered_scenario_reads??[],
     ...(snapshot.retrieval?{retrieval:snapshot.retrieval}:{}),...(changes.length?{basis_changes:changes}:{}),
     evidence:evidence.map(entry=>({evidence_id:entry.evidence_id,kind:entry.kind,text:entry.text,selection_reason:entry.selection_reason,snapshot_status:entry.status,cited:cited.has(entry.evidence_id),
      ...(entry.navigation?{navigation:entry.navigation}:{}),timing:entry.timing??{recorded_at:null,source_started_at:null,source_ended_at:null,source_time_complete:false},event:entry.event??null,conditions:entry.conditions??null,evolution:entry.evolution??null,valid_at:entry.valid_at??null,invalid_at:entry.invalid_at??null}))};
   }catch(error){failure=error;throw error;}
  });
  return {status:200,body};
 }catch(error){
  const cause=failure??error;
  return cause instanceof ReplyStoreError
   ?{status:cause.code==='reply_incomplete'?409:404,body:{error:cause.code==='reply_incomplete'?'reply_incomplete':'not_found'}}
   :{status:503,body:{error:'evidence_unavailable'}};
 }
}
