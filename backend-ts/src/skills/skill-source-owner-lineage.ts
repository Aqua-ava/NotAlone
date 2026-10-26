/** 本人记忆沿原SELF及手录根复验，供Skill来源使用。 */
import type {Client} from 'pg';
import {activeRef,UnavailableEvidence,parseStoredJSON,decisionAvailable,validateFrozen,documentsAvailable,captureSnapshot,digest} from '../memory/overview/contact-overview-evidence.ts';
import type {Evidence} from '../memory/overview/contact-overview-evidence.ts';
export async function skillOwnerLineage(client: Client, owner: string, memory: Evidence): Promise<Evidence> {
  const contact=null;
  const identifiers: string[] = memory.source_ids.filter((id:string)=>id!==owner);
  if(memory.source_ids.includes(owner)){
    let current=memory;const seen=new Set<string>();
    while(true){if(seen.has(current.id)||seen.size>=100||current.status==='deleted'||current.adoption_method!=='manual'||!current.source_ids.includes(owner))throw new UnavailableEvidence();seen.add(current.id);
      if(!current.supersedes_memory_id){if(current.source_candidate_id||current.source_ids.length!==1)throw new UnavailableEvidence();break;}
      current=(await client.query('SELECT * FROM public.owner_memory WHERE owner_id=$1 AND id=$2',[owner,current.supersedes_memory_id])).rows[0];if(!current)throw new UnavailableEvidence();
    }
  }
  const available = (await client.query(`SELECT id FROM public.source_document WHERE owner_id=$1 AND ($2::uuid IS NULL OR contact_id=$2) AND status='active' AND id=ANY($3::uuid[])
    UNION SELECT id FROM public.local_wechat_observation WHERE owner_id=$1 AND ($2::uuid IS NULL OR contact_id=$2) AND id=ANY($3::uuid[])
    UNION SELECT message.id FROM public.message message WHERE message.owner_id=$1 AND ($2::uuid IS NULL OR message.contact_id=$2) AND message.id=ANY($3::uuid[]) AND EXISTS (SELECT 1 FROM public.message_source_ref ref WHERE ref.owner_id=message.owner_id AND ref.contact_id=message.contact_id AND ref.message_id=message.id AND ${activeRef})`, [owner, contact, identifiers])).rows;
  if (available.length !== new Set(identifiers).size) throw new UnavailableEvidence();
  const candidate = memory.source_candidate_id ? (await client.query('SELECT subject,correction_evidence,dimension_evidence::text AS dimension_evidence_text FROM public.memory_candidate WHERE owner_id=$1 AND ($2::uuid IS NULL OR contact_id=$2) AND id=$3', [owner,contact,memory.source_candidate_id])).rows[0] : null;
  if(memory.source_candidate_id&&candidate?.subject!=='self')throw new UnavailableEvidence();
  if (candidate?.correction_evidence && (candidate.correction_evidence.decision_ids?.length || candidate.correction_evidence.has_memory_context) && !(await decisionAvailable(client,owner,candidate.correction_evidence))) throw new UnavailableEvidence();
  const original: Evidence[] = [], windows: Evidence[] = [], sources = new Set<string>(identifiers);
  if (candidate?.correction_evidence && candidate.correction_evidence.kind !== 'generation_unknown') { original.push(candidate.correction_evidence); windows.push(candidate.correction_evidence); }
  const decisions = (await client.query("SELECT * FROM public.memory_correction_decision WHERE owner_id=$1 AND ($2::uuid IS NULL OR contact_id=$2) AND record_kind='owner_memory' AND (record_id=$3 OR replacement_memory_id=$3)", [owner,contact,memory.id])).rows;
  for (const decision of decisions) {
    const evidence = decision.evidence;
    if (evidence.kind === 'erased_guard') {
      if (decision.decision !== 'rejected' || decision.rejected_text !== null || decision.corrected_text !== null || !Array.isArray(evidence.canonical_ids) || !evidence.canonical_ids.length || Object.keys(evidence).sort().join(',') !== 'canonical_ids,kind,version' || evidence.version !== 1 || new Set(evidence.canonical_ids).size !== evidence.canonical_ids.length) throw new UnavailableEvidence();
      const valid = await client.query(`SELECT 1 FROM public.message message JOIN public.message_source_ref ref ON ref.owner_id=message.owner_id AND ref.contact_id=message.contact_id AND ref.message_id=message.id WHERE message.owner_id=$1 AND ($2::uuid IS NULL OR message.contact_id=$2) AND message.id=ANY($3::uuid[]) AND ${activeRef} LIMIT 1`, [owner,contact,evidence.canonical_ids]);
      if (!valid.rowCount) throw new UnavailableEvidence();
    } else if (!(await decisionAvailable(client, owner, evidence))) throw new UnavailableEvidence();
    sources.add(decision.id);
    if (!['generation_unknown','erased_guard'].includes(evidence.kind)) {
      windows.push(evidence);
      if (decision.decision === 'corrected' && decision.replacement_memory_id === memory.id) original.push(evidence);
    }
  }
  if (memory.version_evidence) for (const window of [memory.version_evidence.previous_window,memory.version_evidence.current_window]) if (window) windows.push(window);
  const refs = new Map<string, Evidence>();
  for (const window of windows) {
    await validateFrozen(client, owner, window);
    if (!(await decisionAvailable(client,owner,window))) throw new UnavailableEvidence();
    for (const id of [...window.source_ids,...window.message_ids]) sources.add(id);
    for (const ref of window.source_refs) { for (const id of [ref.source_id,ref.message_id,ref.ref_id]) sources.add(id); refs.set(`${ref.message_id}/${ref.ref_id}/${ref.source_id}`,ref); }
  }
  const traces = (await client.query(`SELECT DISTINCT dependency.source_id FROM public.memory_extraction_trace_dependency dependency JOIN public.memory_extraction_trace_link link ON link.owner_id=dependency.owner_id AND link.trace_id=dependency.trace_id WHERE link.owner_id=$1 AND ((link.record_kind='owner_memory' AND link.record_id=$2) OR (link.record_kind='candidate' AND link.record_id=$3))`,[owner,memory.id,memory.source_candidate_id])).rows;
  for (const trace of traces) sources.add(trace.source_id);
  if (memory.source_candidate_id) sources.add(memory.source_candidate_id);
  if (!(await documentsAvailable(client,owner,[...sources]))) throw new UnavailableEvidence();
  const originalRefs = windows.length ? [...new Set<string>(windows.flatMap(window => window.source_refs.map((ref: Evidence) => ref.ref_id)))] : null;
  const direct = await captureSnapshot(client,owner,memory.source_ids,memory.source_ids,contact,originalRefs);
  for (const id of direct.source_ids) sources.add(id);
  let previous=memory;const visited=new Set<string>();
  while(previous){if(visited.has(previous.id)||visited.size>=100||previous.status==='deleted')throw new UnavailableEvidence();visited.add(previous.id);
    if(previous.source_candidate_id){const c=(await client.query('SELECT subject FROM public.memory_candidate WHERE owner_id=$1 AND id=$2',[owner,previous.source_candidate_id])).rows[0];if(c?.subject!=='self')throw new UnavailableEvidence();sources.add(previous.source_candidate_id);}
    if(!previous.supersedes_memory_id)break;sources.add(previous.supersedes_memory_id);previous=(await client.query('SELECT * FROM public.owner_memory WHERE owner_id=$1 AND id=$2',[owner,previous.supersedes_memory_id])).rows[0];if(!previous)throw new UnavailableEvidence();
  }
  if(memory.source_ids.includes(owner))sources.add(owner);
  const sourceRows = (await client.query('SELECT id,status,source_type,content_sha256 FROM public.source_document WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[owner,[...sources]])).rows;
  const context: Evidence[] = [];
  for (const [kind, table] of [['contact_memory','confirmed_memory'],['owner_memory','owner_memory']]) {
    const rows = (await client.query(`SELECT id,revision,status,text_content,category,topic,source_ids,source_candidate_id,adoption_method,valid_at::text,invalid_at::text,supersedes_memory_id,event,version_evidence FROM public.${table} WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND id<>$3 ORDER BY id`,[owner,[...sources],memory.id])).rows;
    for (const row of rows) {
      for (const key of ['valid_at','invalid_at']) if (row[key]) {
        row[key] = row[key].replace(/([+-]\d{2})$/, '$1:00').replace(/\.(\d+)(?=[+-])/, (_: string, fraction: string) => `.${fraction.padEnd(6,'0')}`);
      }
      context.push({record_kind:kind,memory_id:row.id,revision:row.revision,status:row.status,record_sha256:digest(row)});
    }
  }
  return {source_ids:[...sources].sort(),source_refs:[...refs.values()].sort((a,b) => a.ref_id.localeCompare(b.ref_id)),context_records:context,original_known:!!original.length,original_ref_ids:originalRefs,
    generation_sha256:digest({frozen_windows:windows,direct,dimension_evidence:candidate?.dimension_evidence_text ? parseStoredJSON(candidate.dimension_evidence_text) : null,sources:sourceRows,context_records:context,trace_dependency_ids:traces.map(row => row.source_id).sort()})};
}
