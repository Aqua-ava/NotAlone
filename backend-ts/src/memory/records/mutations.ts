import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {MemoryMutationError,conflict,ensureMemorySources,bumpMemoryRevision,recordMemoryDecision,type MemoryRow} from './mutations/protection.ts';
import {eraseMemoryBodies,eraseMemoryDependencies,eraseRecordTraces,eraseCandidateBodies,eraseLayeredReplies} from './mutations/erasure.ts';
import {deleteSourceReplies,type ErasurePorts} from '../../preferences/preference-erasure.ts';
import {normalizeConditions,normalizeEvolution} from '../overview/projection/metadata.ts';
import {overviewRecordDigest} from '../overview/projection/memory.ts';
import {validateFrozen,decisionAvailable} from '../overview/evidence/sources.ts';
export interface MemoryMutationDependencies { beforeErase?:()=>Promise<void>; erasurePorts?:Partial<ErasurePorts> }
async function manualConditions(client:Client,owner:string,previous:MemoryRow,body:MemoryRow):Promise<MemoryRow|null> {
  let raw='conditions' in body?body.conditions:previous.conditions;
  if(raw==null)return null;
  let value:MemoryRow|null;
  try {
    if('conditions' in body) {
      if(typeof raw!=='object'||Array.isArray(raw)||!Array.isArray(raw.items))throw new Error();
      raw={...raw,items:raw.items.map((item:MemoryRow)=>{
        if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).sort().join('|')!=='evidence|text')throw new Error();
        return {...item,source_supported:false};
      })};
    }
    value=normalizeConditions(raw);
  }catch{throw new MemoryMutationError(400,'手动条件无效。');}
  if(!value)throw new MemoryMutationError(400,'手动条件无效。');
  const refs=value.items.flatMap((i:MemoryRow)=>i.evidence);
  if(refs.some((r:MemoryRow)=>!previous.source_ids.includes(r.message_id)))conflict('条件位置超出本资料来源。');
  if(refs.length) {
    const rows=(await client.query('SELECT id,length(text_content) AS length FROM public.message WHERE owner_id=$1 AND id=ANY($2::uuid[])',[owner,[...new Set(refs.map((r:MemoryRow)=>r.message_id))]])).rows;
    const lengths=new Map(rows.map(r=>[r.id,r.length]));if(refs.some((r:MemoryRow)=>!lengths.has(r.message_id)||r.char_end>lengths.get(r.message_id)))conflict('条件位置已不可用。');
  }
  return {...value,items:value.items.map((i:MemoryRow)=>({...i,source_supported:false}))};
}
async function versionLegal(client:Client,row:MemoryRow,previous:MemoryRow):Promise<boolean> {
  const proof=row.version_evidence;
  if(!proof||proof.version!==1||!proof.previous_window||!proof.current_window||!proof.previous||!proof.current)return false;
  try {
    for(const window of[proof.previous_window,proof.current_window]) {await validateFrozen(client,row.owner_id,window);if(!(await decisionAvailable(client,row.owner_id,window)))return false;}
    return previous.status==='invalidated'&&previous.owner_id===row.owner_id&&previous.contact_id===row.contact_id
      &&row.supersedes_memory_id===proof.previous.memory_id&&previous.revision===proof.previous.revision+1
      &&overviewRecordDigest(previous,normalizeEvolution(previous.evolution),proof.previous.revision,proof.previous.invalid_at)===proof.previous.record_sha256
      &&row.id===proof.current.memory_id&&row.revision===proof.current.revision
      &&overviewRecordDigest(row,normalizeEvolution(row.evolution))===proof.current.record_sha256;
  }catch(error){if(error&&typeof error==='object'&&'code' in error)throw error;return false;}
}
/** 调用者提供已开始且持有contact→owner锁的PG事务，返回原表完整行。 */
export async function mutateMemory(client:Client,owner:string,scope:{contactId?:string,level:'contact'|'owner'},action:string,id:string|undefined,body:MemoryRow,dependencies:MemoryMutationDependencies={}):Promise<MemoryRow> {
  if(!id||!['correct','delete','revert-auto-update'].includes(action))throw new MemoryMutationError(400,'记忆操作参数无效。');
  const table=scope.level==='owner'?'owner_memory':'confirmed_memory',kind=scope.level==='owner'?'owner_memory':'contact_memory';
  const contact=scope.level==='contact'?scope.contactId??null:null;
  if(scope.level==='contact'&&!contact)throw new MemoryMutationError(400,'联系人范围无效。');
  const where=table==='confirmed_memory'?'owner_id=$1 AND id=$2 AND contact_id=$3':'owner_id=$1 AND id=$2';
  const parameters=[owner,id,...(contact?[contact]:[])];
  const row=(await client.query(`SELECT to_jsonb(m) AS value FROM public.${table} m WHERE ${where} FOR UPDATE`,parameters)).rows[0]?.value;
  if(!row)throw new MemoryMutationError(404,'资料不存在。');
  if(action==='correct') {
    if(typeof body.text!=='string'||!body.text.trim())throw new MemoryMutationError(400,'修正后的资料不能为空。');
    const category=body.category??row.category,change=body.change_kind??'error_correction';
    if(!['common_fact','preference','taboo','recent_state','relationship_note'].includes(category)||!['error_correction','state_changed'].includes(change))throw new MemoryMutationError(400,'修正参数无效。');
    if(row.status!=='active') {
      if(contact) {
        const replay=(await client.query("SELECT to_jsonb(m) AS value FROM public.confirmed_memory m WHERE owner_id=$1 AND contact_id=$2 AND supersedes_memory_id=$3 AND status='active' AND adoption_method='manual' AND text_content=$4 AND category=$5",[owner,contact,id,body.text,category])).rows[0]?.value;
        if(replay&&row.retirement_reason===change) {
          await ensureMemorySources(client,owner,contact,replay);
          const decisions=(await client.query('SELECT evidence FROM public.memory_correction_decision WHERE owner_id=$1 AND(record_id=$2 OR replacement_memory_id=$2)',[owner,replay.id])).rows;
          for(const d of decisions){if(!(await decisionAvailable(client,owner,d.evidence)))conflict();try{await validateFrozen(client,owner,d.evidence);}catch(error){if(error&&typeof error==='object'&&'code' in error)throw error;conflict();}}
          return replay;
        }
      }
      conflict();
    }
    if(!contact&&(row.valid_at&&Date.now()<Date.parse(row.valid_at)||row.invalid_at&&Date.now()>=Date.parse(row.invalid_at)))conflict();
    await ensureMemorySources(client,owner,contact,row);
    const conditions=await manualConditions(client,owner,row,body);
    const nextId=randomUUID();
    const columns=['id','owner_id',...(contact?['contact_id']:[]),'text_content','category','topic','source_ids','adoption_method','status','valid_at','invalid_at','revision','confidence','risk_flags','supersedes_memory_id','source_dependency_mode','requires_all_sources','conditions'];
    const values=[nextId,owner,...(contact?[contact]:[]),body.text,category,row.topic,row.source_ids,'manual','active',row.valid_at,row.invalid_at,row.revision+1,row.confidence,row.risk_flags,id,row.source_dependency_mode,row.requires_all_sources,conditions];
    const updated=(await client.query(`INSERT INTO public.${table}(${columns.join(',')}) VALUES(${values.map((_,i)=>`$${i+1}`).join(',')}) RETURNING to_jsonb(${table}) AS value`,values)).rows[0].value;
    await client.query(`UPDATE public.${table} SET status='invalidated',retirement_reason=$3,retired_at=now(),revision=$4,updated_at=now() WHERE owner_id=$1 AND id=$2`,[owner,id,change,updated.revision]);
    await recordMemoryDecision(client,{owner,contactId:contact,recordKind:kind,record:row,rejectedText:row.text_content,correctedText:body.text,replacementId:nextId,changeKind:change});
    await bumpMemoryRevision(client,owner,contact);return updated;
  }
  if(action==='delete') {
    if(row.status==='deleted')return row;
    if((await client.query(`SELECT 1 FROM public.${table} m WHERE owner_id=$1 AND(supersedes_memory_id=$2 OR to_jsonb(m)->'merge_parent_ids' ? $2::text) LIMIT 1`,[owner,id])).rowCount)conflict('资料版本已变化，请重新查看当前版本后删除。');
    if(!dependencies.beforeErase)throw new MemoryMutationError(503,'删除备份清理尚未装配。');
    await dependencies.beforeErase();
    await eraseLayeredReplies(client,owner,contact,[id,...row.source_ids],dependencies.erasurePorts);
    await recordMemoryDecision(client,{owner,contactId:contact,recordKind:kind,record:row});
    await deleteSourceReplies(client,owner,[id],contact,false,dependencies.erasurePorts);
    await eraseRecordTraces(client,owner,kind,id);
    await eraseMemoryBodies(client,owner,table,id,dependencies.erasurePorts);
    const update=contact?"invalid_at=COALESCE(invalid_at,now()),revision=revision+1,":"";
    const result=(await client.query(`UPDATE public.${table} SET status='deleted',${update}updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING to_jsonb(${table}) AS value`,[owner,id])).rows[0].value;
    await bumpMemoryRevision(client,owner,contact);return result;
  }
  const versionConflict=(message='资料版本已变化。'):never=>{throw new MemoryMutationError(409,message,'memory_version_changed');};
  if(!Number.isSafeInteger(body.expected_revision)||body.expected_revision<1)throw new MemoryMutationError(400,'资料修订号无效。');
  if(row.status!=='active'||row.adoption_method!=='auto'||row.revision!==body.expected_revision||!row.supersedes_memory_id)versionConflict('只有仍合法的自动更新可以撤销。');
  const previous=(await client.query(`SELECT to_jsonb(m) AS value FROM public.${table} m WHERE owner_id=$1 AND id=$2 FOR UPDATE`,[owner,row.supersedes_memory_id])).rows[0]?.value;
  if(!previous||previous.adoption_method!=='auto'||!await versionLegal(client,row,previous)||(await client.query(`SELECT 1 FROM public.${table} WHERE owner_id=$1 AND supersedes_memory_id=$2 AND status='active'`,[owner,id])).rowCount)versionConflict('原版本或人工决定已变化，不能恢复。');
  await ensureMemorySources(client,owner,contact,{...row,source_ids:[...new Set([...row.source_ids,...previous.source_ids])]});
  await eraseLayeredReplies(client,owner,contact,contact?[id,previous.id,...row.source_ids,...previous.source_ids]:[id,previous.id],dependencies.erasurePorts);
  let proof=previous.version_evidence;
  if(proof) {
    const ancestor=(await client.query(`SELECT to_jsonb(m) AS value FROM public.${table} m WHERE owner_id=$1 AND id=$2`,[owner,previous.supersedes_memory_id])).rows[0]?.value;
    const historical={...previous,status:'active',revision:proof.current?.revision};
    if(ancestor&&await versionLegal(client,historical,ancestor))proof={...proof,current:{memory_id:previous.id,revision:body.expected_revision+1,record_sha256:overviewRecordDigest({...historical,revision:body.expected_revision+1},normalizeEvolution(previous.evolution))}};
  }
  await deleteSourceReplies(client,owner,[id],contact,false,dependencies.erasurePorts);
  await recordMemoryDecision(client,{owner,contactId:contact,recordKind:kind,record:row});
  await eraseRecordTraces(client,owner,kind,id);
  await eraseMemoryDependencies(client,owner,[id,...(row.source_candidate_id?[row.source_candidate_id]:[])],[],dependencies.erasurePorts);
  await client.query(`UPDATE public.${table} SET text_content='已删除的资料',status='deleted',revision=revision+1,risk_flags='{}'::text[],event=NULL,version_evidence=NULL,conditions=NULL,evolution=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2`,[owner,id]);
  await eraseCandidateBodies(client,owner,row.source_candidate_id?[row.source_candidate_id]:[]);
  const restored=(await client.query(`UPDATE public.${table} SET status='active',revision=$3,version_evidence=$4,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING to_jsonb(${table}) AS value`,[owner,previous.id,body.expected_revision+1,proof])).rows[0]?.value;
  if(!restored)versionConflict();await bumpMemoryRevision(client,owner,contact);return restored;
}
