import type {Client} from 'pg';
import {activeRef,decisionAvailable} from '../overview/contact-overview-evidence.ts';
import {projectOverviewMemory} from '../overview/contact-overview-memory.ts';
import {ownerMemoryPayload} from './memory-owner-projection.ts';
import {MemoryError} from './memory-errors.ts';
export type MemoryRow=Record<string,any>;
export type MemoryScope={level:'contact'|'owner';contactId?:string};
export async function availableMemorySources(client:Client,owner:string,ids:string[],contact?:string):Promise<Set<string>> {
  const rows=(await client.query(`SELECT id FROM public.source_document WHERE owner_id=$1 AND ($2::uuid IS NULL OR contact_id=$2) AND id=ANY($3::uuid[]) AND status='active'
    UNION SELECT id FROM public.local_wechat_observation WHERE owner_id=$1 AND ($2::uuid IS NULL OR contact_id=$2) AND id=ANY($3::uuid[])
    UNION SELECT m.id FROM public.message m WHERE owner_id=$1 AND ($2::uuid IS NULL OR contact_id=$2) AND id=ANY($3::uuid[])
    AND EXISTS(SELECT 1 FROM public.message_source_ref ref WHERE ref.owner_id=m.owner_id AND ref.contact_id=m.contact_id AND ref.message_id=m.id AND ${activeRef})`,[owner,contact??null,ids])).rows;
  return new Set(rows.map(row=>row.id));
}
async function correctionAvailable(client:Client,owner:string,row:MemoryRow,level:string):Promise<boolean> {
  const decisions=(await client.query('SELECT * FROM public.memory_correction_decision WHERE owner_id=$1 AND record_kind=$2 AND (record_id=$3 OR replacement_memory_id=$3)',[owner,level==='owner'?'owner_memory':'contact_memory',row.id])).rows;
  for(const decision of decisions) {
    const evidence=decision.evidence;
    if(evidence.kind==='erased_guard') {
      if(decision.decision!=='rejected'||decision.rejected_text!==null||decision.corrected_text!==null||evidence.version!==1||!Array.isArray(evidence.canonical_ids)||!evidence.canonical_ids.length
        ||Object.keys(evidence).sort().join('|')!=='canonical_ids|kind|version'||new Set(evidence.canonical_ids).size!==evidence.canonical_ids.length)return false;
      const found=(await client.query(`SELECT 1 FROM public.message m WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[]) AND EXISTS(SELECT 1 FROM public.message_source_ref ref WHERE ref.owner_id=m.owner_id AND ref.contact_id=m.contact_id AND ref.message_id=m.id AND ${activeRef}) LIMIT 1`,[owner,decision.contact_id,evidence.canonical_ids])).rowCount;
      if(!found)return false;
    } else if(!await decisionAvailable(client,owner,evidence))return false;
  }
  if(row.source_candidate_id) {
    const evidence=(await client.query('SELECT correction_evidence FROM public.memory_candidate WHERE owner_id=$1 AND id=$2',[owner,row.source_candidate_id])).rows[0]?.correction_evidence;
    if(evidence&&(evidence.decision_ids?.length||evidence.has_memory_context)&&!await decisionAvailable(client,owner,evidence))return false;
  }
  return true;
}
export async function memoryVisible(client:Client,owner:string,scope:MemoryScope,row:MemoryRow,all=false):Promise<boolean> {
  const available=await availableMemorySources(client,owner,row.source_ids,scope.level==='contact'?scope.contactId:undefined);
  const manualOwner=scope.level==='owner'&&row.adoption_method==='manual'&&!row.source_candidate_id&&row.source_ids.length===1&&row.source_ids[0]===owner;
  if(!manualOwner&&!available.size)return false;
  if((all||row.status==='invalidated'||row.source_dependency_mode==='all')&&!row.source_ids.every((id:string)=>available.has(id)||scope.level==='owner'&&id===owner))return false;
  return correctionAvailable(client,owner,row,scope.level);
}
export async function contactOwnerRows(client:Client,owner:string,contact:string,rows:MemoryRow[]):Promise<MemoryRow[]> {
  const parents=(await client.query("SELECT to_jsonb(m) AS value FROM public.owner_memory m WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND status<>'deleted'",[owner,rows.map(r=>r.supersedes_memory_id).filter(Boolean)])).rows.map(r=>r.value);
  const available=await availableMemorySources(client,owner,[...new Set<string>([...rows,...parents].flatMap(row=>row.source_ids))],contact);
  const visible=new Set([...rows,...parents].filter(row=>row.source_ids.length&&row.source_ids.every((id:string)=>available.has(id))).map(row=>row.id));
  return rows.filter(row=>visible.has(row.id)).map(row=>{
    const result={...row};
    if(row.supersedes_memory_id&&!visible.has(row.supersedes_memory_id)){result.supersedes_memory_id=null;result.version_evidence=null;}
    if(result.version_evidence&&['previous_window','current_window'].some(key=>{
      const window=result.version_evidence[key];return window&&Object.values(window.message_scopes).some(id=>id!==contact);
    }))result.version_evidence=null;
    return result;
  });
}
export async function readMemoryRows(client:Client,owner:string,scope:MemoryScope,id?:string):Promise<MemoryRow[]> {
  const table=scope.level==='owner'?'owner_memory':'confirmed_memory';
  const contact=scope.level==='contact'?scope.contactId:null;
  let rows:MemoryRow[]=[];
  if(id) {
    const pending:{id:string;ancestors:Set<string>}[]=[{id,ancestors:new Set()}],seen=new Set<string>();
    while(pending.length) {
      const current=pending.shift()!;
      if(current.ancestors.has(current.id))throw new MemoryError('memory_version_changed',409);
      if(seen.has(current.id))continue;
      if(seen.size>=100)throw new MemoryError('memory_version_changed',409);
      seen.add(current.id);
      const row=(await client.query(`SELECT to_jsonb(m) AS value FROM public.${table} m WHERE owner_id=$1 ${contact?'AND contact_id=$3':''} AND id=$2 AND status<>'deleted'`,contact?[owner,current.id,contact]:[owner,current.id])).rows[0]?.value;
      if(!row){if(!rows.length)throw new MemoryError('memory_not_found',404);continue;}
      rows.push(row);
      const ancestors=new Set([...current.ancestors,current.id]);
      for(const parent of [row.supersedes_memory_id,...(row.merge_parent_ids??[])].filter(Boolean))pending.push({id:parent,ancestors});
    }
  } else {
    rows=(await client.query(`SELECT to_jsonb(m) AS value FROM public.${table} m WHERE owner_id=$1 ${contact?'AND contact_id=$2':''} AND status IN ('active','invalidated') AND (valid_at IS NULL OR valid_at<=now()) ORDER BY created_at,id`,contact?[owner,contact]:[owner])).rows.map(r=>r.value);
  }
  if(scope.level==='owner'&&scope.contactId) {
    const visible=await contactOwnerRows(client,owner,scope.contactId,rows);
    if(id) {
      const allowed=new Map(visible.map(row=>[row.id,row]));const limited=[];
      for(const row of rows){if(!allowed.has(row.id))break;limited.push(allowed.get(row.id)!);}
      if(!limited.length||!limited.some(row=>row.id===id))throw new MemoryError('memory_not_found',404);
      limited.at(-1)!.supersedes_memory_id=null;rows=limited;
    } else rows=visible;
  }
  const result=[];
  for(const row of rows) {
    if(await memoryVisible(client,owner,scope,row,!!id))result.push(row);
    else if(id)throw new MemoryError('memory_not_found',404);
  }
  return result;
}
export async function memoryPayload(client:Client,row:MemoryRow,level:'contact'|'owner'):Promise<MemoryRow> {
  if(level==='owner')return ownerMemoryPayload(client,row);
  const {payload}=await projectOverviewMemory(client,row);
  delete payload.source_candidate_id;
  return payload;
}
