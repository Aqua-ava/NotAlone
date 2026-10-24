import type { Client } from 'pg';
import { normalizeEvolution } from './contact-overview-metadata.ts';
import { validateFrozen, decisionAvailable } from './contact-overview-evidence.ts';
import { overviewRecordDigest } from './contact-overview-memory.ts';
type Row=Record<string,any>;
function semanticFailure(error:unknown):boolean { return !(error && typeof error==='object' && 'code' in error); }
async function evolutionValid(client:Client,owner:string,value:Row,allowRetired=false):Promise<boolean> {
  try {
    const proof=value.proof;
    if(!proof?.sources || proof.scope?.owner_id!==owner) return false;
    await validateFrozen(client,owner,proof.sources);
    if(new Set(Object.values(proof.sources.message_scopes)).size!==1 || Object.values(proof.sources.message_scopes)[0]!==proof.scope.contact_id) return false;
    const related=new Set(value.related_versions.map((item:Row)=>item.memory_id));
    for(const parent of proof.parents) {
      if(!related.has(parent.memory_id)) continue;
      const table=parent.subject==='self'?'owner_memory':'confirmed_memory';
      const row=(await client.query(`SELECT to_jsonb(memory) AS value FROM public.${table} memory WHERE owner_id=$1 AND id=$2`,[owner,parent.memory_id])).rows[0]?.value;
      if(!row || row.status==='deleted' || (table==='confirmed_memory'&&row.contact_id!==proof.scope.contact_id)) return false;
      if(allowRetired?![parent.revision,parent.revision+1].includes(row.revision):row.status!=='active'||row.revision!==parent.revision) return false;
      if(overviewRecordDigest(row,normalizeEvolution(row.evolution),parent.revision,parent.invalid_at)!==parent.record_sha256) return false;
    }
    return true;
  } catch(error) { if(!semanticFailure(error)) throw error; return false; }
}
export async function projectEvolution(client:Client,row:Row):Promise<{current:Row|null;stored:Row|null}> {
  let stored=normalizeEvolution(row.evolution);
  if(stored && !await evolutionValid(client,row.owner_id,stored,true)) stored=null;
  const conflicts=(await client.query(`SELECT evolution FROM public.memory_candidate
    WHERE owner_id=$1 AND status='pending' AND evolution->>'kind'='unresolved_conflict'
      AND evolution->'related_versions' @> $2::jsonb ORDER BY created_at DESC LIMIT 8`,
    [row.owner_id,JSON.stringify([{memory_id:row.id,revision:row.revision}])])).rows;
  for(const candidate of conflicts) {
    const conflict=normalizeEvolution(candidate.evolution);
    if(conflict&&await evolutionValid(client,row.owner_id,conflict)) return {current:conflict,stored};
  }
  return {current:stored,stored};
}
export async function projectVersionEvidence(client:Client,row:Row,storedEvolution:Row|null,scope:'contact'|'owner'='contact'):Promise<{evidence:Row|null;current:boolean;canRevert:boolean}> {
  const evidence=row.version_evidence??null;
  if(!evidence) return {evidence:null,current:false,canRevert:false};
  const keys=['version','previous','current','previous_window','current_window'];
  if(evidence.version!==1 || Object.keys(evidence).sort().join('|')!==keys.sort().join('|')
    || !evidence.previous || !evidence.current) throw new Error('版本依据字段无效。');
  const previousKeys=['memory_id','revision','adoption_method','valid_at','invalid_at','record_sha256'];
  if(Object.keys(evidence.previous).sort().join('|')!==previousKeys.sort().join('|')
    || Object.keys(evidence.current).sort().join('|')!==['memory_id','revision','record_sha256'].sort().join('|')
    || !['auto','manual'].includes(evidence.previous.adoption_method)) throw new Error('版本依据结构无效。');
  for(const item of [evidence.previous,evidence.current]) if(!Number.isInteger(item.revision)||item.revision<1
    || !/^[a-f0-9]{64}$/.test(item.record_sha256)||! /^[a-f0-9-]{36}$/i.test(item.memory_id)) throw new Error('版本依据标识无效。');
  for(const key of ['valid_at','invalid_at']) {
    const value=evidence.previous[key];
    if(value!==null&&(typeof value!=='string'||!Number.isFinite(Date.parse(value))||!/(Z|[+-]\d\d:\d\d)$/.test(value))) throw new Error('旧版本有效期无效。');
  }
  validateWindow(evidence.previous_window); validateWindow(evidence.current_window);
  let current=false;
  try {
    for(const window of [evidence.previous_window,evidence.current_window]) {
      if(!window) return {evidence,current:false,canRevert:false};
      await validateFrozen(client,row.owner_id,window);
      if(!await decisionAvailable(client,row.owner_id,window)) return {evidence,current:false,canRevert:false};
    }
    const table=scope==='owner'?'owner_memory':'confirmed_memory';
    const previous=(await client.query(`SELECT to_jsonb(memory) AS value FROM public.${table} memory WHERE owner_id=$1 AND id=$2`,
      [row.owner_id,evidence.previous.memory_id])).rows[0]?.value;
    const available=previous && previous.status==='invalidated' && row.supersedes_memory_id===evidence.previous.memory_id
      && (scope==='owner'||previous.contact_id===row.contact_id) && previous.revision===evidence.previous.revision+1
      && overviewRecordDigest(previous,normalizeEvolution(previous.evolution),evidence.previous.revision,evidence.previous.invalid_at)===evidence.previous.record_sha256;
    current=Boolean(available&&row.id===evidence.current.memory_id&&row.revision===evidence.current.revision
      &&overviewRecordDigest(row,storedEvolution)===evidence.current.record_sha256);
  } catch(error) { if(!semanticFailure(error)) throw error; }
  return {evidence,current,canRevert:current&&row.status==='active'&&row.adoption_method==='auto'
    &&evidence.previous.adoption_method==='auto'&&row.supersedes_memory_id===evidence.previous.memory_id};
}

function validateWindow(value:Row|null):void {
  if(value===null) return;
  const fail=()=>{throw new Error('版本窗口结构无效。');};
  const keys=(item:any,names:string[])=>item&&typeof item==='object'&&!Array.isArray(item)
    &&Object.keys(item).sort().join('|')===[...names].sort().join('|');
  const uuid=(item:any)=>typeof item==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(item);
  const digest=(item:any)=>typeof item==='string'&&/^[a-f\d]{64}$/.test(item);
  if(!keys(value,['version','ordered_message_ids','message_ids','source_ids','source_refs','message_digests','message_snapshots','message_scopes'])||value!.version!==1) fail();
  for(const key of ['ordered_message_ids','message_ids','source_ids']) if(!Array.isArray(value![key])||value![key].length>1000
    ||new Set(value![key]).size!==value![key].length||!value![key].every(uuid)) fail();
  const ids=value!.message_ids;
  if(!ids.length || [...ids].sort().join('|')!==[...value!.ordered_message_ids].sort().join('|')) fail();
  for(const key of ['message_digests','message_snapshots','message_scopes']) if(!keys(value![key],ids)) fail();
  for(const id of ids) {
    const snapshot=value!.message_snapshots[id];
    if(!digest(value!.message_digests[id])||!uuid(value!.message_scopes[id])
      ||!keys(snapshot,['message_id','text_sha256','text_length','sender','message_type','occurred_at','text_representation','source_refs','source_state_sha256'])
      ||snapshot.message_id!==id||!digest(snapshot.text_sha256)||!digest(snapshot.source_state_sha256)
      ||!Number.isInteger(snapshot.text_length)||snapshot.text_length<1||!['self','contact'].includes(snapshot.sender)
      ||typeof snapshot.message_type!=='string'||!snapshot.message_type.trim()||!['text','processed_text','placeholder','unknown'].includes(snapshot.text_representation)
      ||!Array.isArray(snapshot.source_refs)||!snapshot.source_refs.length
      ||snapshot.source_refs.some((ref:Row)=>!keys(ref,['ref_id','source_id'])||!uuid(ref.ref_id)||!uuid(ref.source_id))) fail();
    if(snapshot.occurred_at!==null&&(typeof snapshot.occurred_at!=='string'||!Number.isFinite(Date.parse(snapshot.occurred_at))||!/(Z|[+-]\d\d:\d\d)$/.test(snapshot.occurred_at))) fail();
  }
  if(!Array.isArray(value!.source_refs)||value!.source_refs.some((ref:Row)=>!keys(ref,['message_id','ref_id','source_id','digest'])
    ||!uuid(ref.message_id)||!uuid(ref.ref_id)||!uuid(ref.source_id)||!digest(ref.digest))) fail();
}
