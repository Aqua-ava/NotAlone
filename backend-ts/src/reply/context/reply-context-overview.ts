/** 回复双概览在调用方同一事务读取；只返回来源可核验的导航。 */
import type {Client} from 'pg';
import {readContactOverview} from '../../memory/overview/contact-overview.ts';
import {skillOwnerLineage} from '../../skills/skill-source-owner-lineage.ts';
import {projectOverviewMemory,overviewRecordDigest} from '../../memory/overview/contact-overview-memory.ts';
import {projectEvolution,projectVersionEvidence} from '../../memory/overview/contact-overview-versions.ts';
import {digest,UnavailableEvidence,overviewReferences,readLineage} from '../../memory/overview/contact-overview-evidence.ts';
import {projectReplyMemoryMetadata,ownerMemorySourceDependencies} from './reply-context-memory.ts';
import {ReplyContextError,type ContextScope,type ContextMetadata} from './reply-context-types.ts';
export interface ReplyOverviewSnapshot {
 scope_kind:'contact'|'owner';owner_id:string;contact_id:string|null;
 projection_revision:string;memory_revision:number;entries:ContextMetadata[];
}
export async function readReplyContactOverview(client:Client,scope:ContextScope):Promise<ReplyOverviewSnapshot>{
 const result=await readContactOverview(client,scope.owner_id,scope.contact_id,true);
 for(const entry of result.entries){
  const row=(await client.query('SELECT to_jsonb(m) AS value FROM public.confirmed_memory m WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[scope.owner_id,scope.contact_id,entry.memory.memory_id])).rows[0]?.value;
  if(!row)throw new ReplyContextError('概览资料已变化。');
  const lineage=await readLineage(client,scope.owner_id,scope.contact_id,row),projected=await projectOverviewMemory(client,row);
  entry.dependency_manifest={memory_id:row.id,revision:row.revision,status:row.status,record_sha256:projected.recordDigest,timing_sha256:digest(projected.timing),version_evidence_sha256:digest(projected.versionEvidence),current_event_sha256:digest(projected.eventCurrent),version_evidence_source_current:!!projected.payload.version_evidence_source_current,source_generation_sha256:lineage.generation_sha256,original_known:lineage.original_known,context_records:lineage.context_records,source_ids:lineage.source_ids,source_refs:lineage.source_refs};
 }
 return {...result,owner_id:scope.owner_id};
}
export async function readReplyOwnerOverview(client:Client,owner:string,organization=false):Promise<ReplyOverviewSnapshot>{
 if(!(await client.query('SELECT 1 FROM public.owner WHERE id=$1',[owner])).rowCount)throw new ReplyContextError('本人范围不可用。');
 const revision=Number((await client.query('SELECT memory_revision FROM public.owner_memory_state WHERE owner_id=$1',[owner])).rows[0]?.memory_revision??0);
 const rows=(await client.query("SELECT to_jsonb(m) AS value FROM public.owner_memory m WHERE owner_id=$1 AND status IN ('active','invalidated') AND ($2 OR category IN ('common_fact','preference','taboo')) ORDER BY created_at,id",[owner,organization])).rows;
 const entries:ContextMetadata[]=[],dependencies:ContextMetadata[]=[];
 for(const {value:row} of rows){
  try{
   await ownerMemorySourceDependencies(client,owner,row);
   const lineage=await skillOwnerLineage(client,owner,row),metadata=await projectReplyMemoryMetadata(client,row,'owner_memory');
   const evolution=await projectEvolution(client,row),version=await projectVersionEvidence(client,row,evolution.stored,'owner');
   const manual=row.source_ids.length===1&&row.source_ids[0]===owner;
   const contacts=(await client.query(`SELECT DISTINCT contact_id FROM public.message WHERE owner_id=$1 AND id=ANY($2::uuid[]) UNION SELECT contact_id FROM public.source_document WHERE owner_id=$1 AND id=ANY($2::uuid[]) UNION SELECT contact_id FROM public.local_wechat_observation WHERE owner_id=$1 AND id=ANY($2::uuid[])`,[owner,row.source_ids])).rows;
   const references:ContextMetadata[]=manual?[{source_id:owner,source_kind:'manual',message_id:null,contact_id:null}]:[];
   if(!manual)for(const item of contacts)for(const ref of await overviewReferences(client,owner,item.contact_id,row.source_ids,lineage.original_ref_ids))references.push({...ref,contact_id:item.contact_id});
   const kind=manual?'manual_entry':references.length&&lineage.original_known?'source_supported':'unknown';
   const manifest={memory_id:row.id,revision:row.revision,status:row.status,record_sha256:overviewRecordDigest(row,evolution.current),timing_sha256:digest(metadata.timing),version_evidence_sha256:digest(version.evidence),current_event_sha256:digest(metadata.event),version_evidence_source_current:!!version.current,source_generation_sha256:lineage.generation_sha256,original_known:manual||lineage.original_known,context_records:lineage.context_records,source_ids:lineage.source_ids,source_refs:lineage.source_refs};
   dependencies.push(manifest);entries.push({memory:{...row,...metadata,memory_id:row.id,text:row.text_content},provenance:{kind,references},dependency_ids:lineage.source_ids,dependency_manifest:manifest,is_latest:false,current_leaf:null});
  }catch(error){if(!(error instanceof UnavailableEvidence)&&!(error instanceof ReplyContextError))throw error;}
 }
 const children=new Map<string,ContextMetadata>();
 for(const entry of entries)if(entry.memory.supersedes_memory_id){if(children.has(entry.memory.supersedes_memory_id))throw new ReplyContextError('本人概览存在竞争版本。');children.set(entry.memory.supersedes_memory_id,entry);}
 for(const entry of entries){let current=entry;const seen=new Set<string>();while(children.has(current.memory.memory_id)){if(seen.has(current.memory.memory_id))throw new ReplyContextError('本人概览版本循环。');seen.add(current.memory.memory_id);current=children.get(current.memory.memory_id)!;}entry.current_leaf=current.memory.status==='active'?{memory_id:current.memory.memory_id,revision:current.memory.revision}:null;entry.is_latest=entry.current_leaf?.memory_id===entry.memory.memory_id;}
 return {scope_kind:'owner',owner_id:owner,contact_id:null,projection_revision:digest({version:1,memory_revision:revision,memories:dependencies}),memory_revision:revision,entries};
}
