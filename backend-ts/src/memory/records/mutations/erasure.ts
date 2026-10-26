import type { Client } from 'pg';
import { activeGuard,bumpMemoryRevision,type MemoryRow } from './protection.ts';
import { deleteSourceReplies, type ErasurePorts } from '../../../preferences/preference-erasure.ts';
export async function eraseTraceBodies(client:Client,owner:string,ids:string[],reason='memory_deleted'):Promise<void> {
  if(!ids.length)return;
  await client.query(`INSERT INTO public.memory_extraction_trace_link(trace_id,owner_id,contact_id,record_kind,record_id,commit_status,operation) SELECT DISTINCT e.trace_id,e.owner_id,e.contact_id,'message',(m->>'message_id')::uuid,'committed','input' FROM public.memory_extraction_trace_event e CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload->'messages')='array' THEN e.payload->'messages' ELSE '[]'::jsonb END) m WHERE e.owner_id=$1 AND e.trace_id=ANY($2::uuid[]) AND e.stage='window' AND m->>'message_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ON CONFLICT DO NOTHING`,[owner,ids]);
  await client.query('DELETE FROM public.memory_extraction_trace_event WHERE owner_id=$1 AND trace_id=ANY($2::uuid[])',[owner,ids]);
  await client.query('DELETE FROM public.memory_extraction_trace_dependency WHERE owner_id=$1 AND trace_id=ANY($2::uuid[])',[owner,ids]);
  await client.query("UPDATE public.memory_extraction_trace SET status='deleted',deletion_reason=$3,failure_stage=NULL,error_code=NULL WHERE owner_id=$1 AND trace_id=ANY($2::uuid[])",[owner,ids,reason]);
}
export async function eraseSourceTraces(client:Client,owner:string,ids:string[],contact:string|null=null,reason='source_deleted'):Promise<void> {
  if(!ids.length)return;
  const rows=(await client.query(`SELECT DISTINCT trace_id FROM public.memory_extraction_trace_dependency
    WHERE owner_id=$1 AND source_id=ANY($2::uuid[]) AND ($3::uuid IS NULL OR contact_id=$3)
   UNION SELECT DISTINCT trace_id FROM public.memory_extraction_trace_link
    WHERE owner_id=$1 AND record_id=ANY($2::uuid[]) AND ($3::uuid IS NULL OR contact_id=$3)
   UNION SELECT DISTINCT event.trace_id FROM public.memory_extraction_trace_event event
    WHERE event.owner_id=$1 AND ($3::uuid IS NULL OR event.contact_id=$3) AND event.stage='window'
     AND ((event.payload->'target_message_ids') ?| $4::text[] OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(event.payload->'messages')='array'
       THEN event.payload->'messages' ELSE '[]'::jsonb END) message
      WHERE message->>'message_id'=ANY($4::text[]) OR EXISTS(
       SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(message->'source_snapshots')='array'
        THEN message->'source_snapshots' ELSE '[]'::jsonb END) source
       WHERE source->>'source_id'=ANY($4::text[]) OR source->>'source_ref_id'=ANY($4::text[]))))`,
   [owner,ids,contact,ids])).rows;
  await eraseTraceBodies(client,owner,rows.map(r=>r.trace_id),reason);
}
export async function eraseRecordTraces(client:Client,owner:string,kind:string,id:string):Promise<void> {
  let candidate=null;
  if(kind!=='candidate') {const table=kind==='owner_memory'?'owner_memory':'confirmed_memory';candidate=(await client.query(`SELECT source_candidate_id FROM public.${table} WHERE owner_id=$1 AND id=$2`,[owner,id])).rows[0]?.source_candidate_id;}
  const rows=(await client.query("SELECT trace_id FROM public.memory_extraction_trace_link WHERE owner_id=$1 AND((record_kind=$2 AND record_id=$3) OR(record_kind='candidate' AND record_id=$4)) UNION SELECT trace_id FROM public.memory_extraction_trace_dependency WHERE owner_id=$1 AND source_id=$3",[owner,kind,id,candidate])).rows;
  await eraseTraceBodies(client,owner,rows.map(r=>r.trace_id));
}
export async function eraseLayeredReplies(client:Client,owner:string,contact:string|null,ids:string[],ports?:Partial<ErasurePorts>):Promise<void> {
  const rows=(await client.query(`SELECT v.id FROM public.scenario_document_version v JOIN public.layered_memory_batch b ON b.id=v.batch_id WHERE b.owner_id=$1 AND b.contact_id IS NOT DISTINCT FROM $2::uuid AND b.dependency_ids && $3::uuid[] UNION SELECT v.id FROM public.layered_profile_version v JOIN public.layered_profile_batch b ON b.id=v.batch_id WHERE b.owner_id=$1 AND b.contact_id IS NOT DISTINCT FROM $2::uuid AND b.dependency_ids && $3::uuid[]`,[owner,contact,ids])).rows;
  if(rows.length) await deleteSourceReplies(client,owner,rows.map(r=>r.id),contact,false,ports);
}
export async function eraseDecisionBody(client:Client,decision:MemoryRow):Promise<void> {
  const ids=await activeGuard(client,decision.owner_id,decision.contact_id,decision.evidence.canonical_ids??decision.evidence.message_ids??[]);
  if(ids.length) await client.query("UPDATE public.memory_correction_decision SET decision='rejected',rejected_text=NULL,corrected_text=NULL,replacement_memory_id=NULL,evidence=$3 WHERE owner_id=$1 AND id=$2",[decision.owner_id,decision.id,{version:1,kind:'erased_guard',canonical_ids:ids}]);
  else await client.query('DELETE FROM public.memory_correction_decision WHERE owner_id=$1 AND id=$2',[decision.owner_id,decision.id]);
}
export async function eraseMemoryUpgrades(client:Client,owner:string,ids:string[]):Promise<void> {
  const batches=(await client.query("SELECT id FROM public.memory_upgrade_batch WHERE owner_id=$1 AND state<>'invalidated' AND dependency_ids && $2::uuid[]",[owner,ids])).rows.map(r=>r.id);
  if(!batches.length)return;
  const traces=(await client.query('SELECT trace.trace_id FROM public.memory_extraction_trace trace JOIN public.memory_upgrade_batch batch ON batch.id=trace.run_id AND batch.owner_id=trace.owner_id AND batch.contact_id=trace.contact_id WHERE batch.owner_id=$1 AND batch.id=ANY($2::uuid[])',[owner,batches])).rows;
  await eraseTraceBodies(client,owner,traces.map(r=>r.trace_id),'manual');
  const rows=(await client.query("UPDATE public.memory_upgrade_batch SET state='invalidated',revision=revision+1,message_ids='{}',source_generation='{}',memory_generation=NULL,extracted_outcome=NULL,comparison=NULL,adjudications=NULL,applied_records=NULL,dependency_ids='{}',trace_id=NULL,error_code='sources_changed' WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND state<>'invalidated' RETURNING task_id,job_id",[owner,batches])).rows;
  const tasks=rows.map(r=>r.task_id);
  await client.query("UPDATE public.background_task SET status='cancelled',finished_at=now(),updated_at=now() WHERE id=ANY($1::uuid[]) AND status<>'succeeded'",[tasks]);
  await client.query("UPDATE public.background_task_step SET status='cancelled',worker_id=NULL,lease_expires_at=NULL,lease_generation=lease_generation+1 WHERE task_id=ANY($1::uuid[]) AND status<>'succeeded'",[tasks]);
  await client.query('UPDATE public.memory_upgrade_job SET revision=revision+1 WHERE owner_id=$1 AND id=ANY($2::uuid[])',[owner,[...new Set(rows.map(r=>r.job_id))]]);
}
/** 擦除跨记忆的纠错派生闭包；保留集合仅保护版本墓碑，不保留正文副本。 */
export async function eraseMemoryDependencies(client:Client,owner:string,removedIds:string[],preservedIds:string[]=[],ports?:Partial<ErasurePorts>):Promise<void> {
  await eraseMemoryUpgrades(client,owner,removedIds);
  const candidates=(await client.query("SELECT id,contact_id FROM public.memory_candidate WHERE owner_id=$1 AND correction_evidence->'source_ids' ?| $2::text[]",[owner,removedIds])).rows;
  const decisions=(await client.query("SELECT * FROM public.memory_correction_decision WHERE owner_id=$1 AND evidence->'source_ids' ?| $2::text[]",[owner,removedIds])).rows;
  const candidateIds=new Set<string>(candidates.map(r=>r.id)); for(const d of decisions)if(d.record_kind==='candidate')candidateIds.add(d.record_id);
  const groups:Record<string,MemoryRow[]>={};
  for(const [kind,table] of [['contact_memory','confirmed_memory'],['owner_memory','owner_memory']]) {
    const seeds=decisions.filter(d=>d.record_kind===kind).flatMap(d=>[d.record_id,...(d.replacement_memory_id?[d.replacement_memory_id]:[])]);
    groups[kind]=(await client.query(`WITH RECURSIVE affected(id) AS(SELECT id FROM public.${table} WHERE owner_id=$1 AND(id=ANY($2::uuid[]) OR source_candidate_id=ANY($3::uuid[])) UNION SELECT m.id FROM public.${table} m JOIN affected a ON m.supersedes_memory_id=a.id OR to_jsonb(m)->'merge_parent_ids' ? a.id::text WHERE m.owner_id=$1) SELECT to_jsonb(m) AS value FROM public.${table} m WHERE owner_id=$1 AND id IN(SELECT id FROM affected)`,[owner,seeds,[...candidateIds]])).rows.map(r=>r.value);
  }
  const all=[...groups.contact_memory,...groups.owner_memory];for(const row of all)if(row.source_candidate_id)candidateIds.add(row.source_candidate_id);
  await client.query("UPDATE public.memory_candidate SET correction_evidence=$3,correction_decision_ids=NULL,updated_at=now() WHERE owner_id=$1 AND correction_evidence->'source_ids' ?| $2::text[] AND NOT id=ANY($4::uuid[])",[owner,removedIds,{version:1,kind:'generation_unknown'},[...candidateIds]]);
  const affected=[...candidateIds,...all.map(r=>r.id)]; await eraseSourceTraces(client,owner,affected);
  const contacts=new Set<string>([...candidates,...groups.contact_memory].map(r=>r.contact_id));
  if(groups.owner_memory.length)for(const r of(await client.query("SELECT DISTINCT contact_id FROM public.reply_request WHERE owner_id=$1 AND state='running'",[owner])).rows)contacts.add(r.contact_id);
  for(const contact of contacts) {
    await deleteSourceReplies(client,owner,affected,contact,true,ports);
    await client.query("UPDATE public.contact_memory_index SET topics='[]'::jsonb,status='stale',updated_at=now() WHERE owner_id=$1 AND contact_id=$2",[owner,contact]);await bumpMemoryRevision(client,owner,contact);
  }
  if(groups.owner_memory.length)await deleteSourceReplies(client,owner,affected,null,false,ports);
  const contactIds=groups.contact_memory.map(r=>r.id).filter(id=>!preservedIds.includes(id));
  await client.query('UPDATE public.confirmed_memory SET supersedes_memory_id=NULL WHERE owner_id=$1 AND supersedes_memory_id=ANY($2::uuid[])',[owner,contactIds]);
  await client.query('DELETE FROM public.confirmed_memory WHERE owner_id=$1 AND id=ANY($2::uuid[])',[owner,contactIds]);
  await client.query('DELETE FROM public.owner_memory WHERE owner_id=$1 AND id=ANY($2::uuid[])',[owner,groups.owner_memory.map(r=>r.id).filter(id=>!preservedIds.includes(id))]);
  await client.query('DELETE FROM public.memory_candidate WHERE owner_id=$1 AND id=ANY($2::uuid[])',[owner,[...candidateIds].filter(id=>!preservedIds.includes(id))]);
  const tombstones=(await client.query("SELECT * FROM public.memory_correction_decision WHERE owner_id=$1 AND evidence->>'kind'='erased_guard'",[owner])).rows;
  for(const decision of [...decisions,...tombstones])await eraseDecisionBody(client,decision);
}
export async function eraseMemoryBodies(client:Client,owner:string,table:'confirmed_memory'|'owner_memory',id:string,ports?:Partial<ErasurePorts>):Promise<void> {
  const kind=table==='owner_memory'?'owner_memory':'contact_memory';
  const rows=(await client.query(`WITH RECURSIVE versions AS(SELECT id,supersedes_memory_id,source_candidate_id,to_jsonb(m)->'merge_parent_ids' AS parents FROM public.${table} m WHERE owner_id=$1 AND id=$2 UNION SELECT m.id,m.supersedes_memory_id,m.source_candidate_id,to_jsonb(m)->'merge_parent_ids' FROM public.${table} m JOIN versions v ON m.id=v.supersedes_memory_id OR m.supersedes_memory_id=v.id OR v.parents ? m.id::text OR to_jsonb(m)->'merge_parent_ids' ? v.id::text WHERE m.owner_id=$1) SELECT id,source_candidate_id FROM versions`,[owner,id])).rows;
  const memories=rows.map(r=>r.id),candidates=rows.map(r=>r.source_candidate_id).filter(Boolean),ids=[...memories,...candidates];
  await eraseMemoryDependencies(client,owner,ids,ids,ports);
  for(const row of rows)await eraseRecordTraces(client,owner,kind,row.id);
  await eraseSourceTraces(client,owner,ids);
  const contacts=table==='confirmed_memory'?(await client.query('SELECT DISTINCT contact_id FROM public.confirmed_memory WHERE owner_id=$1 AND id=ANY($2::uuid[])',[owner,memories])).rows:(await client.query('SELECT DISTINCT contact_id FROM public.memory_candidate WHERE owner_id=$1 AND id=ANY($2::uuid[])',[owner,candidates])).rows;
  for(const {contact_id:contact} of contacts) {
    await client.query("UPDATE public.contact_memory_index SET topics='[]'::jsonb,status='stale',updated_at=now() WHERE owner_id=$1 AND contact_id=$2",[owner,contact]);
    await deleteSourceReplies(client,owner,ids,contact,false,ports);
  }
  if(table==='owner_memory')await deleteSourceReplies(client,owner,ids,null,false,ports);
  for(const d of(await client.query('SELECT * FROM public.memory_correction_decision WHERE owner_id=$1 AND(record_id=ANY($2::uuid[]) OR replacement_memory_id=ANY($3::uuid[]))',[owner,ids,memories])).rows)await eraseDecisionBody(client,d);
  await client.query(`UPDATE public.${table} SET text_content='已删除的资料',status='deleted',risk_flags='{}'::text[],event=NULL,version_evidence=NULL,conditions=NULL,evolution=NULL,updated_at=now() WHERE owner_id=$1 AND id=ANY($2::uuid[])`,[owner,memories]);
  await eraseCandidateBodies(client,owner,candidates);
}
export async function eraseCandidateBodies(client:Client,owner:string,ids:string[]):Promise<void> {
  await client.query("UPDATE public.memory_candidate SET text_content='已删除的资料',status='rejected',interpretation_reason='',alternatives='{}'::text[],risk_flags='{}'::text[],failure_reason=NULL,dimension_evidence=NULL,correction_evidence=NULL,correction_decision_ids=NULL,event=NULL,conditions=NULL,evolution=NULL,updated_at=now() WHERE owner_id=$1 AND id=ANY($2::uuid[])",[owner,ids]);
}
