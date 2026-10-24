import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { MemoryError } from './memory-errors.ts';
import { activeRef, captureSnapshot, validateFrozen, decisionAvailable, documentsAvailable, canonicalJSON } from './contact-overview-evidence.ts';
export type MemoryRow = Record<string, any>;
export class MemoryMutationError extends MemoryError {
  constructor(status: number, _message: string, code?: string) {
    super(code ?? (status===409?'memory_correction_conflict':status===404?'memory_not_found':status===503?'memory_unavailable':'memory_request_invalid'),status);
  }
}
export function conflict(message='资料或来源已变化，请刷新后核对。'): never { throw new MemoryMutationError(409,message); }
export async function bumpMemoryRevision(client: Client, owner: string, contact: string | null): Promise<void> {
  if (contact) await client.query('INSERT INTO public.contact_memory_state(owner_id,contact_id,memory_revision) VALUES($1,$2,1) ON CONFLICT(owner_id,contact_id) DO UPDATE SET memory_revision=contact_memory_state.memory_revision+1,updated_at=now()',[owner,contact]);
}
export async function ensureMemorySources(client: Client, owner: string, contact: string | null, row: MemoryRow): Promise<void> {
  const missing=(message:string):never=>{throw new MemoryMutationError(404,message);};
  let ids: string[]=[...new Set<string>(row.source_ids)];
  if(row.source_dependency_mode==='all') {
    if(!row.source_ids.length||ids.length!==row.source_ids.length)missing('ALL来源必须非空且唯一。');
    const all=(await client.query(`SELECT m.id,m.contact_id FROM public.message m WHERE m.owner_id=$1 AND ($2::uuid IS NULL OR m.contact_id=$2) AND m.id=ANY($3::uuid[]) AND EXISTS(SELECT 1 FROM public.message_source_ref ref WHERE ref.owner_id=m.owner_id AND ref.contact_id=m.contact_id AND ref.message_id=m.id AND ${activeRef}) FOR SHARE OF m`,[owner,contact,ids])).rows;
    if(all.length!==ids.length||new Set(all.map(r=>r.contact_id)).size!==1)missing('ALL来源须为同一范围内全部活动的规范消息。');
    return;
  }
  if (!contact && ids.includes(owner) && row.source_dependency_mode!=='all') {
    let current=row; const visited=new Set<string>(); let valid=false;
    for(let index=0;index<100;index++) {
      if (!current || visited.has(current.id) || current.owner_id!==owner || current.status==='deleted' || current.adoption_method!=='manual' || !current.source_ids.includes(owner)) missing('本人手录来源关联已失效。');
      visited.add(current.id);
      if (!current.supersedes_memory_id) { valid=!current.source_candidate_id && current.source_ids.length===1; break; }
      current=(await client.query('SELECT to_jsonb(m) AS value FROM public.owner_memory m WHERE owner_id=$1 AND id=$2',[owner,current.supersedes_memory_id])).rows[0]?.value;
    }
    if(!valid) missing('本人手录来源关联无效。');
    ids=ids.filter(id=>id!==owner);
  }
  const rows=(await client.query(`SELECT id FROM public.source_document WHERE owner_id=$1 AND ($2::uuid IS NULL OR contact_id=$2) AND status='active' AND id=ANY($3::uuid[])
    UNION SELECT id FROM public.local_wechat_observation WHERE owner_id=$1 AND ($2::uuid IS NULL OR contact_id=$2) AND id=ANY($3::uuid[])
    UNION SELECT message.id FROM public.message message WHERE message.owner_id=$1 AND ($2::uuid IS NULL OR message.contact_id=$2) AND message.id=ANY($3::uuid[]) AND EXISTS(SELECT 1 FROM public.message_source_ref ref WHERE ref.owner_id=message.owner_id AND ref.contact_id=message.contact_id AND ref.message_id=message.id AND ${activeRef})`,[owner,contact,ids])).rows;
  if(rows.length!==ids.length) missing('资料来源范围校验失败。');
}
export function mergeEvidence(target: MemoryRow, other: MemoryRow): void {
  const frozen=new Set<string>(other.message_ids);
  for(const key of ['message_ids','source_ids']) target[key]=[...new Set([...(target[key]??[]),...(other[key]??[])])].sort();
  const refs=new Map<string,MemoryRow>();
  for(const ref of [...(target.source_refs??[]).filter((r:MemoryRow)=>!frozen.has(r.message_id)),...(other.source_refs??[])]) refs.set(`${ref.message_id}/${ref.ref_id}/${ref.source_id}`,ref);
  target.source_refs=[...refs.values()].sort((a,b)=>`${a.message_id}/${a.ref_id}`.localeCompare(`${b.message_id}/${b.ref_id}`));
  target.message_digests={...(target.message_digests??{}),...(other.message_digests??{})};
  for(const key of ['message_snapshots','message_scopes']) {
    target[key]??={}; for(const id of frozen)delete target[key][id];
    Object.assign(target[key],other[key]??{});
  }
  if(other.has_memory_context)target.has_memory_context=true;
}
async function validate(client:Client,owner:string,evidence:MemoryRow) {
  try { await validateFrozen(client,owner,evidence); } catch(error) { if(error&&typeof error==='object'&&'code' in error) throw error; conflict(); }
}
export async function selectedTraceMembers(client:Client,owner:string,kind:string,id:string,candidateId:string):Promise<{traces:MemoryRow[],messages:string[],dependencies:string[]}> {
  const traces=(await client.query(`SELECT DISTINCT t.trace_id,t.status FROM public.memory_extraction_trace t JOIN public.memory_extraction_trace_link l ON l.owner_id=t.owner_id AND l.trace_id=t.trace_id WHERE l.owner_id=$1 AND ((l.record_kind=$2 AND l.record_id=$3) OR(l.record_kind='candidate' AND l.record_id=$4))`,[owner,kind,id,candidateId])).rows;
  const ids=traces.map(r=>r.trace_id);
  const messages=(await client.query(`SELECT record_id::text AS id FROM public.memory_extraction_trace_link WHERE owner_id=$1 AND trace_id=ANY($2::uuid[]) AND record_kind='message' AND operation='input' UNION SELECT m->>'message_id' FROM public.memory_extraction_trace_event e CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload->'messages')='array' THEN e.payload->'messages' ELSE '[]'::jsonb END) m WHERE e.owner_id=$1 AND e.trace_id=ANY($2::uuid[]) AND e.stage='window' AND m->>'message_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,[owner,ids])).rows.map(r=>r.id);
  const dependencies=(await client.query('SELECT source_id FROM public.memory_extraction_trace_dependency WHERE owner_id=$1 AND trace_id=ANY($2::uuid[])',[owner,ids])).rows.map(r=>r.source_id);
  return {traces,messages,dependencies};
}
export async function captureCandidateEvidence(client:Client,candidate:MemoryRow,validateGeneration=true):Promise<MemoryRow> {
  const owner=candidate.owner_id, contact=candidate.contact_id, sources:string[]=candidate.source_ids;
  const stored=candidate.correction_evidence;
  if(!stored || stored.kind==='generation_unknown' || !stored.message_snapshots || !stored.message_scopes || canonicalJSON(Object.keys(stored.message_snapshots).sort())!==canonicalJSON([...stored.message_ids].sort()) || canonicalJSON(Object.keys(stored.message_scopes).sort())!==canonicalJSON([...stored.message_ids].sort())) return {version:1,kind:'generation_unknown',direct_message_ids:[],message_ids:[],source_ids:[],source_refs:[],message_digests:{},message_snapshots:{},message_scopes:{},manual_entry:false};
  if(validateGeneration)await validate(client,owner,stored);
  const dimension=candidate.dimension_evidence;
  const window=[...new Set<string>([...sources,...stored.message_ids,...(dimension?.messages??[]).map((r:MemoryRow)=>r.message_id)])];
  const evidence=await captureSnapshot(client,owner,window,sources,contact);
  const direct=new Set(evidence.source_refs.filter((r:MemoryRow)=>sources.includes(r.message_id)||sources.includes(r.source_id)).map((r:MemoryRow)=>r.message_id));
  mergeEvidence(evidence,stored);
  if(stored.unknown_memory_context) evidence.unknown_memory_context=true;
  if(dimension&&validateGeneration) {
    const refs=dimension.messages.flatMap((m:MemoryRow)=>m.source_refs.map((r:MemoryRow)=>r.ref_id));
    const current=await captureSnapshot(client,owner,dimension.messages.map((m:MemoryRow)=>m.message_id),[],contact,refs);
    for(const message of dimension.messages) {
      for(const [key,value] of Object.entries(message)) {
        if(key==='source_state_sha256'&&value===null || key==='text_representation'&&value==='unknown') continue;
        const sort=(v:any)=>key==='source_refs'?[...v].sort((a,b)=>a.ref_id.localeCompare(b.ref_id)):v;
        if(canonicalJSON(sort(current.message_snapshots[message.message_id]?.[key]))!==canonicalJSON(sort(value))) conflict('参与候选的来源世代已变化。');
      }
    }
  }
  const dependencies=new Set<string>(evidence.source_ids);
  const traces=(await client.query(`SELECT DISTINCT d.source_id FROM public.memory_extraction_trace_dependency d JOIN public.memory_extraction_trace_link l ON l.owner_id=d.owner_id AND l.trace_id=d.trace_id WHERE l.owner_id=$1 AND l.record_kind='candidate' AND l.record_id=$2`,[owner,candidate.id])).rows;
  for(const row of traces) dependencies.add(row.source_id);
  const contexts=(await client.query(`SELECT c.correction_evidence,c.dimension_evidence FROM public.memory_candidate c WHERE c.owner_id=$1 AND c.id IN (SELECT source_candidate_id FROM public.confirmed_memory WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[]) UNION SELECT source_candidate_id FROM public.owner_memory WHERE owner_id=$1 AND id=ANY($3::uuid[]))`,[owner,contact,[...dependencies]])).rows;
  if(contexts.length) evidence.has_memory_context=true;
  for(const row of contexts) {
    if(row.correction_evidence) { if(validateGeneration)await validate(client,owner,row.correction_evidence); mergeEvidence(evidence,row.correction_evidence); for(const id of row.correction_evidence.source_ids) dependencies.add(id); }
    else if(validateGeneration)evidence.unknown_memory_context=true;
    for(const m of row.dimension_evidence?.messages??[]) { dependencies.add(m.message_id); for(const r of m.source_refs) dependencies.add(r.source_id); }
  }
  const decisions=(await client.query("SELECT evidence FROM public.memory_correction_decision WHERE owner_id=$1 AND scope_kind='self' AND replacement_memory_id=ANY($2::uuid[])",[owner,[...dependencies]])).rows;
  if(decisions.length) evidence.has_memory_context=true;
  for(const row of decisions) { if(validateGeneration)await validate(client,owner,row.evidence); mergeEvidence(evidence,row.evidence); for(const id of row.evidence.source_ids) dependencies.add(id); }
  evidence.direct_message_ids=[...direct].sort(); evidence.source_ids=[...dependencies].sort();
  const count=(await client.query("SELECT count(*)::int AS total FROM public.source_document WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[]) AND source_type='manual' AND status='active'",[owner,contact,sources])).rows[0].total;
  evidence.manual_entry=!evidence.message_ids.length&&count===new Set(sources).size;
  return evidence;
}
export async function activeGuard(client:Client,owner:string,contact:string|null,ids:string[]):Promise<string[]> {
  return (await client.query(`SELECT DISTINCT m.id FROM public.message m JOIN public.message_source_ref ref ON ref.owner_id=m.owner_id AND ref.contact_id=m.contact_id AND ref.message_id=m.id WHERE m.owner_id=$1 AND ($2::uuid IS NULL OR m.contact_id=$2) AND m.id=ANY($3::uuid[]) AND ${activeRef} ORDER BY m.id`,[owner,contact,ids])).rows.map(r=>r.id);
}
export async function protectCandidate(client:Client,candidate:MemoryRow,options:{validateGeneration?:boolean}={}):Promise<{row:MemoryRow,evidence:MemoryRow,decisionIds:string[],reviews:MemoryRow[]}> {
  const validateGeneration=options.validateGeneration!==false;
  const evidence=await captureCandidateEvidence(client,candidate,validateGeneration), owner=candidate.owner_id,contact=candidate.contact_id;
  const unavailable=(failure:string)=>({row:{...candidate,status:candidate.status==='pending'?'invalidated':candidate.status,failure_reason:failure},evidence,decisionIds:[],reviews:[]});
  if(evidence.kind==='generation_unknown') {if(validateGeneration)conflict();return unavailable('correction:generation_unknown');}
  if(evidence.has_memory_context&&!(await decisionAvailable(client,owner,evidence))) {if(validateGeneration)conflict();return unavailable('correction:deleted_source');}
  if(evidence.manual_entry&&!candidate.dimension_evidence) return {row:candidate,evidence,decisionIds:[],reviews:[]};
  const direct:string[]=evidence.direct_message_ids;
  const decisions=(await client.query("SELECT * FROM public.memory_correction_decision WHERE owner_id=$1 AND(contact_id=$2 OR(scope_kind='self' AND($3 OR evidence->'message_ids' ?| $4::text[] OR evidence->'canonical_ids' ?| $4::text[]))) ORDER BY created_at,id",[owner,contact,candidate.subject==='self',direct])).rows;
  const ids:string[]=[],reviews:MemoryRow[]=[]; const dependencies=new Set<string>(evidence.source_ids);
  let row={...candidate};
  for(const decision of decisions) {
    const previous=decision.evidence, erased=previous.kind==='erased_guard';
    let old:string[]=previous.message_ids;
    if(erased) {
      if(Object.keys(previous).sort().join(',')!=='canonical_ids,kind,version'||previous.version!==1||decision.decision!=='rejected'||decision.rejected_text!==null||decision.corrected_text!==null||!Array.isArray(previous.canonical_ids)||!previous.canonical_ids.length||new Set(previous.canonical_ids).size!==previous.canonical_ids.length) conflict();
      old=await activeGuard(client,owner,decision.contact_id,previous.canonical_ids);
      if(validateGeneration&&canonicalJSON(old)!==canonicalJSON([...previous.canonical_ids].sort())) conflict();
    }
    if(!(decision.contact_id===contact||decision.scope_kind==='self'&&candidate.subject==='self'||direct.some(id=>old.includes(id)))) continue;
    if(erased?!old.length:!(await decisionAvailable(client,owner,previous))) {if(validateGeneration)conflict();return unavailable('correction:deleted_source');}
    if(!erased) {if(validateGeneration)await validate(client,owner,previous);mergeEvidence(evidence,previous);}
    ids.push(decision.id); const previousSources:string[]=erased?old:previous.source_ids;
    for(const id of previousSources) dependencies.add(id);
    evidence.decision_ids=ids; evidence.source_ids=[...dependencies].sort();
    if((direct.length&&direct.every(id=>old.includes(id)))||(!direct.length&&evidence.source_ids.every((id:string)=>previousSources.includes(id)))||!direct.some(id=>!old.includes(id))) {
      row={...row,status:row.status==='pending'?'invalidated':row.status,failure_reason:'correction:old_evidence'}; break;
    }
    const newMessages=direct.filter(id=>!old.includes(id)).sort();
    reviews.push({decision_id:decision.id,decision:decision.decision,previous_text:decision.rejected_text||'原资料已删除；旧证据上的人工否决继续有效。',corrected_text:decision.corrected_text,new_message_ids:newMessages,new_source_ids:[...new Set(evidence.source_refs.filter((r:MemoryRow)=>newMessages.includes(r.message_id)).map((r:MemoryRow)=>r.source_id))].sort(),semantic_relation:candidate.text_content.replace(/\s/g,'').toLowerCase()===(decision.rejected_text??'').replace(/\s/g,'').toLowerCase()?'same':'uncertain',reason:'出现新的规范消息；请核对新依据，原人工决定继续有效。'});
  }
  evidence.decision_ids=ids; evidence.source_ids=[...dependencies].sort();
  if(!row.failure_reason&&evidence.unknown_memory_context) row.failure_reason='version:original_window_unknown';
  return {row,evidence,decisionIds:ids,reviews};
}
async function currentDecision(client:Client,owner:string,contact:string,kind:string,record:MemoryRow,candidate:MemoryRow,visited=new Set<string>()):Promise<MemoryRow> {
  if(visited.has(candidate.id)) conflict(); visited.add(candidate.id);
  const sources:string[]=record.source_ids;
  const count=(await client.query("SELECT count(*)::int AS n FROM public.source_document WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[]) AND source_type='manual' AND status='active'",[owner,contact,sources])).rows[0].n;
  if(sources.length&&count===new Set(sources).size) return {...await captureSnapshot(client,owner,sources,sources,contact),kind:'current_user_decision',manual_entry:true,direct_message_ids:[]};
  const {traces,messages,dependencies:deps}=await selectedTraceMembers(client,owner,kind,record.id,candidate.id);
  if(!traces.length||!messages.length||traces.some(r=>r.status==='deleted')) conflict('旧资料缺少仍可用的精确参与窗口。');
  const dependencies=new Set<string>([...deps,...sources]);
  if(!(await documentsAvailable(client,owner,[...dependencies]))) conflict();
  const evidence=await captureSnapshot(client,owner,messages,[],contact);
  if(canonicalJSON(evidence.message_ids)!==canonicalJSON([...messages].sort())) conflict();
  evidence.kind='current_user_decision'; evidence.manual_entry=false;
  evidence.direct_message_ids=[...new Set(evidence.source_refs.filter((r:MemoryRow)=>sources.includes(r.message_id)||sources.includes(r.source_id)).map((r:MemoryRow)=>r.message_id))].sort();
  const contexts=(await client.query(`SELECT 'contact_memory' AS kind,id,source_candidate_id,source_ids FROM public.confirmed_memory WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[]) AND status<>'deleted' UNION ALL SELECT 'owner_memory',id,source_candidate_id,source_ids FROM public.owner_memory WHERE owner_id=$1 AND id=ANY($3::uuid[]) AND status<>'deleted'`,[owner,contact,[...dependencies]])).rows;
  for(const memory of contexts) {
    for(const id of memory.source_ids) dependencies.add(id);
    let snapshots:MemoryRow[]=[];
    if(!memory.source_candidate_id) {
      snapshots=(await client.query('SELECT evidence FROM public.memory_correction_decision WHERE owner_id=$1 AND replacement_memory_id=$2',[owner,memory.id])).rows.map(r=>r.evidence);
      if(!snapshots.length&&canonicalJSON(memory.source_ids)!==canonicalJSON([owner])) conflict();
    } else {
      const old=(await client.query('SELECT to_jsonb(c) AS value FROM public.memory_candidate c WHERE owner_id=$1 AND id=$2',[owner,memory.source_candidate_id])).rows[0]?.value;
      if(!old) conflict();
      snapshots=[!old.correction_evidence||old.correction_evidence.kind==='generation_unknown'?await currentDecision(client,owner,old.contact_id,memory.kind,memory,old,visited):old.correction_evidence];
    }
    for(const snapshot of snapshots) {await validate(client,owner,snapshot);mergeEvidence(evidence,snapshot);for(const id of snapshot.source_ids) dependencies.add(id);}
  }
  evidence.source_ids=[...new Set([...evidence.source_ids,...dependencies])].sort();
  if(!(await decisionAvailable(client,owner,evidence))) conflict();
  return evidence;
}
export async function recordMemoryDecision(client:Client,args:{owner:string,contactId:string|null,recordKind:string,record:MemoryRow,correctedText?:string,rejectedText?:string,replacementId?:string,changeKind?:string}):Promise<void> {
  const {owner,recordKind,record}=args; let contact=args.contactId;
  const candidateId=recordKind==='candidate'?record.id:record.source_candidate_id;
  const candidate=candidateId?(await client.query('SELECT to_jsonb(c) AS value FROM public.memory_candidate c WHERE owner_id=$1 AND id=$2',[owner,candidateId])).rows[0]?.value:null;
  const self=recordKind==='owner_memory'||candidate?.subject==='self'; contact??=candidate?.contact_id??null;
  const deleting=args.correctedText===undefined&&args.rejectedText===undefined;
  let evidence:MemoryRow;
  if(deleting) {
    const identifiers=new Set<string>(record.source_ids);
    const snapshots=(await client.query('SELECT correction_evidence AS evidence FROM public.memory_candidate WHERE owner_id=$1 AND id=$2 UNION ALL SELECT evidence FROM public.memory_correction_decision WHERE owner_id=$1 AND(record_id=$3 OR replacement_memory_id=$3)',[owner,candidateId??record.id,record.id])).rows;
    for(const r of snapshots) for(const id of r.evidence?.message_ids??r.evidence?.canonical_ids??[]) identifiers.add(id);
    for(const m of candidate?.dimension_evidence?.messages??[]) identifiers.add(m.message_id);
    const trace=await selectedTraceMembers(client,owner,recordKind,record.id,candidateId??record.id); for(const id of trace.messages) identifiers.add(id);
    const canonical=await activeGuard(client,owner,self?null:contact,[...identifiers]); if(!canonical.length) return;
    evidence={version:1,kind:'erased_guard',canonical_ids:canonical};
  } else if(candidate) {
    if(!candidate.correction_evidence||candidate.correction_evidence.kind==='generation_unknown') {
      if(args.correctedText===undefined) conflict();
      evidence=await currentDecision(client,owner,contact!,recordKind,record,candidate);
    } else {
      evidence=await captureCandidateEvidence(client,candidate);
      if(evidence.kind==='generation_unknown') {
        if(args.correctedText===undefined)conflict();
        evidence=await currentDecision(client,owner,contact!,recordKind,record,candidate);
      }
    }
  } else {
    evidence=await captureSnapshot(client,owner,record.source_ids,record.source_ids,contact);
    evidence.direct_message_ids=[...new Set(evidence.source_refs.filter((r:MemoryRow)=>record.source_ids.includes(r.message_id)||record.source_ids.includes(r.source_id)).map((r:MemoryRow)=>r.message_id))].sort();
    const manual=contact?(await client.query("SELECT count(*)::int AS n FROM public.source_document WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[]) AND source_type='manual' AND status='active'",[owner,contact,record.source_ids])).rows[0].n===new Set(record.source_ids).size:canonicalJSON(record.source_ids)===canonicalJSON([owner]);
    evidence.manual_entry=!evidence.message_ids.length&&manual;
  }
  if(!deleting) for(const r of (await client.query('SELECT evidence FROM public.memory_correction_decision WHERE owner_id=$1 AND replacement_memory_id=$2',[owner,record.id])).rows) {await validate(client,owner,r.evidence);mergeEvidence(evidence,r.evidence);}
  if(args.changeKind) evidence.change_kind=args.changeKind;
  await client.query(`INSERT INTO public.memory_correction_decision(id,owner_id,contact_id,scope_kind,record_kind,record_id,replacement_memory_id,decision,rejected_text,corrected_text,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(owner_id,record_kind,record_id) DO NOTHING`,[randomUUID(),owner,self?null:contact,self?'self':'contact',recordKind,record.id,args.replacementId??null,args.correctedText===undefined?'rejected':'corrected',args.rejectedText??null,args.correctedText??null,evidence]);
  const pending=(await client.query("SELECT to_jsonb(c) AS value FROM public.memory_candidate c WHERE owner_id=$1 AND status='pending' AND(($2 AND(subject='self' OR source_ids && $3::uuid[])) OR(NOT $2 AND contact_id=$4))",[owner,self,[...new Set([...(evidence.message_ids??evidence.canonical_ids??[]),...(evidence.source_ids??[])])],contact])).rows;
  for(const item of pending) {
    try {
      const protectedRow=await protectCandidate(client,item.value);
      await client.query("UPDATE public.memory_candidate SET correction_evidence=$3,correction_decision_ids=$4,status=$5,failure_reason=$6,updated_at=now() WHERE owner_id=$1 AND id=$2 AND status='pending'",[owner,item.value.id,protectedRow.evidence,protectedRow.decisionIds,protectedRow.row.status,protectedRow.row.failure_reason??null]);
    } catch(error) {
      if(!(error instanceof MemoryMutationError)) throw error;
      await client.query("UPDATE public.memory_candidate SET status='invalidated',failure_reason='correction:source_changed',updated_at=now() WHERE owner_id=$1 AND id=$2 AND status='pending'",[owner,item.value.id]);
    }
  }
}
