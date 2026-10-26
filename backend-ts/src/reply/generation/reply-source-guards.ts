/** 回复来源、导航与记忆资格的原表守卫；调用方持有owner事务锁。 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { AssistantScope } from './reply-assistant-guards.ts';
import { ReplyStoreError } from './reply-store.ts';
import { evidenceSources,generationDependencies,canonical,legacyJson } from './reply-assistant-erasure.ts';
import { projectReplyMemoryMetadata,type MemoryKind } from '../context/reply-context-memory.ts';
import { pythonISO } from '../../memory/overview/projection/time.ts';
import * as sql from './reply-source-guards-sql.ts';
type Row=Record<string,any>;
const reject=():never=>{throw new ReplyStoreError('reply_context_invalidated');};
const unique=(values:Iterable<string>):string[]=>[...new Set(values)].sort();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const same=(a:unknown,b:unknown):boolean=>canonical(a)===canonical(b);
export type DiscussionGuard=(client:pg.Client,scope:AssistantScope,requestId:string)=>Promise<unknown>;
export type SavedSkillPolicyChange=(client:pg.Client,scope:AssistantScope,requestId:string)=>Promise<string|null>;
export async function registeredNavigationDependencies(client:pg.Client,scope:AssistantScope):Promise<string[]> {
  const args=Array.from({length:8},()=>[scope.owner_id,scope.contact_id]).flat();
  const ids=(await client.query(sql.registeredNavigation,args)).rows.map(r=>r.id);
  if(ids.some(id=>typeof id!=='string'||!uuid.test(id)))reject();return unique(ids);
}
export async function requireDependencies(client:pg.Client,scope:AssistantScope,ids:string[],historical:boolean):Promise<void> {
  if(!ids.length)return;
  const registered=new Set(await registeredNavigationDependencies(client,scope));
  const navigation=ids.filter(id=>registered.has(id));
  const row=(await client.query(sql.availableDependencies,[scope.owner_id,scope.contact_id,ids,historical,navigation])).rows[0];
  if(!row?.available)reject();
}
interface SourceValidation {client:pg.Client;owner:string;active:Set<string>;verified:Map<string,string[]>}
const validations=new AsyncLocalStorage<SourceValidation>();
export async function requireReplySourcesCurrent(client:pg.Client,scope:AssistantScope,requestId:string,historical:boolean,discussion?:DiscussionGuard):Promise<string[]> {
  const current=validations.getStore();
  if(!current||current.client!==client||current.owner!==scope.owner_id)return validations.run({client,owner:scope.owner_id,active:new Set(),verified:new Map()},()=>requireReplySourcesCurrent(client,scope,requestId,historical,discussion));
  const key=requestId+':'+historical;
  if(current.verified.has(key))return [...current.verified.get(key)!];
  if(current.active.has(requestId))reject();current.active.add(requestId);
  try {
    if(!(await client.query('SELECT 1 FROM reply_request WHERE id=$1 AND owner_id=$2 AND contact_id=$3',[requestId,scope.owner_id,scope.contact_id])).rowCount)reject();
    const ancestors=(await client.query(sql.ancestorRequests,[scope.owner_id,requestId,scope.owner_id])).rows.map(r=>r.id);if(!ancestors.length)reject();
    const sources=new Set<string>();
    for(const ancestor of ancestors) {
      const request=(await client.query('SELECT contact_id,context_snapshot FROM reply_request WHERE owner_id=$1 AND id=$2',[scope.owner_id,ancestor])).rows[0];if(!request)reject();
      if(discussion)await discussion(client,{owner_id:scope.owner_id,contact_id:request.contact_id},ancestor);
      else if(request.context_snapshot?.assistant_discussion_snapshot!==undefined)throw new ReplyStoreError('reply_guards_unavailable');
      const captured=(await client.query('SELECT source_id FROM reply_original_source_use WHERE owner_id=$1 AND reply_request_id=$2',[scope.owner_id,ancestor])).rows.map(r=>r.source_id);
      const evidence=(await client.query('SELECT evidence_id,kind,source_ids,evidence_text AS text FROM reply_context_evidence WHERE owner_id=$1 AND reply_request_id=$2',[scope.owner_id,ancestor])).rows;
      let needs=false;
      for(const e of evidence) {
        // 原owner手录归属引用须真实根链；非手录来源仍需当时原始来源快照。
        let refs:string[];
        try {refs=await evidenceSources(client,scope.owner_id,e,false,{historical:historical||ancestor!==requestId,text:e.text});}
        catch(error) {if((error as {code?:string}).code==='assistant_erasure_identity_invalid')reject();throw error;}
        if(e.kind==='message'||refs.length)needs=true;
      }
      if(!captured.length&&needs)reject();for(const id of captured)sources.add(id);
    }
    if(sources.size&&(await client.query(`SELECT id FROM unnest($1::uuid[]) source(id) WHERE NOT EXISTS(SELECT 1 FROM source_document document WHERE document.owner_id=$2 AND document.id=source.id AND document.status='active' UNION ALL SELECT 1 FROM local_wechat_observation observation WHERE observation.owner_id=$2 AND observation.id=source.id) LIMIT 1`,[unique(sources),scope.owner_id])).rowCount)reject();
    const result=unique(sources);current.verified.set(key,result);return [...result];
  } finally {current.active.delete(requestId);}
}
export async function forbiddenGenerationMemoryDependencies(client:pg.Client,scope:AssistantScope,ids:string[]):Promise<{id:string;kind:MemoryKind}[]> {
  if(!ids.length)return [];return (await client.query(sql.forbiddenMemory,[scope.owner_id,ids])).rows;
}
export async function requireGenerationMemoryDependencies(client:pg.Client,scope:AssistantScope,ids:string[]):Promise<void> {
  if((await forbiddenGenerationMemoryDependencies(client,scope,ids)).length)reject();
}
function asciiJSON(value:unknown):string {return canonical(value).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));}
function pythonDatetime(value:string|null):string|null {return value===null?null:pythonISO(value)!.replace('T',' ');}
export async function historicalBasisRevision(client:pg.Client,scope:AssistantScope,ids:string[]):Promise<string> {
  // JSONB文本保留微秒与任意精度整数；普通pg Date会丢微秒。
  const rows=(await client.query(`SELECT to_jsonb(rows)::text AS value FROM (${sql.historicalRows}) rows`,[scope.owner_id,scope.contact_id,scope.owner_id,scope.owner_id,scope.contact_id,ids])).rows;
  const projected:Row[]=[];
  for(const raw of rows) {
    const row=legacyJson(raw.value),kind=row.kind as MemoryKind;
    const metadata=await projectReplyMemoryMetadata(client,{...row,created_at:row.recorded_at},kind);
    const value={...row,evolution:metadata.evolution,text_digest:createHash('sha256').update(row.text_content).digest('hex'),timing:metadata.timing};delete value.text_content;
    for(const k of ['valid_at','invalid_at','recorded_at'])value[k]=pythonDatetime(value[k]);
    projected.push(value);
  }
  return createHash('sha256').update(asciiJSON(projected)).digest('hex');
}
export async function readReplyBasisChanges(client:pg.Client,scope:AssistantScope,requestId:string,savedSkillPolicyChange?:SavedSkillPolicyChange):Promise<Record<string,unknown>[]> {
  const rawRows=(await client.query(`SELECT to_jsonb(rows) AS value FROM (${sql.basisRows}) rows`,[scope.owner_id,scope.contact_id,requestId])).rows;
  const request=(await client.query('SELECT context_snapshot,skill_version_id FROM reply_request WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[scope.owner_id,scope.contact_id,requestId])).rows[0];if(!request)reject();
  const originals=new Map<string,Row>((request.context_snapshot?.evidence??[]).filter((e:Row)=>e&&typeof e.evidence_id==='string').map((e:Row)=>[e.evidence_id,e]));
  const changes=new Map<string,Record<string,unknown>>();
  const add=(evidence_id:string,kind:string,reason:string)=>changes.set(evidence_id+':'+kind,{evidence_id,kind,reason});
  for(const {value:row} of rawRows) {
    const original=originals.get(row.evidence_id)??{},kind=row.kind as MemoryKind;
    const meta=await projectReplyMemoryMetadata(client,{...row,id:row.evidence_id,status:row.current_status,created_at:row.recorded_at,source_candidate_id:row.event_candidate_id},kind);
    const wasHistorical=!!original.navigation&&original.timing?.current_status==='historical';
    if(wasHistorical&&row.current_status==='invalidated')meta.timing={...meta.timing,current_status:'historical',current_status_reason:'用户明确记录后来发生变化；旧版本仅作历史参考，不表示当前仍成立，记录时间不等于变化时间。'};
    else if(wasHistorical&&row.expired)meta.timing={...meta.timing,current_status:'historical',current_status_reason:'已离开资料声明的引用区间；当前未核实，不认定事件完成或现实状态结束。'};
    let reason:string|undefined;
    if((['invalidated','rejected'].includes(row.current_status)||row.expired)&&!(row.current_status==='active'&&!row.expired))reason='memory_generation_forbidden';
    else if(row.current_status!==row.original_status||row.original_revision!==null&&row.revision!==row.original_revision||Object.hasOwn(original,'evolution')&&!same(original.evolution,meta.evolution))reason='memory_revised';
    else if(row.future)reason='memory_not_yet_valid';
    else if(row.expired&&!wasHistorical)reason='memory_expired';
    else {
      const period=Object.hasOwn(original,'valid_at')&&Object.hasOwn(original,'invalid_at')&&['valid_at','invalid_at'].some(k=>pythonISO(row[k])!==pythonISO(original[k]));
      if(period||typeof original.timing?.current_status==='string'&&original.timing.current_status!==meta.timing.current_status||Object.hasOwn(original,'event')&&!same(original.event,meta.event)||Object.hasOwn(original,'conditions')&&!same(original.conditions,meta.conditions))reason='memory_time_changed';
    }
    if(reason)add(row.evidence_id,kind,reason);
  }
  const deps=await generationDependencies(client,scope.owner_id,scope.contact_id,{turn_dependencies:[],reply_request_id:requestId});
  for(const forbidden of await forbiddenGenerationMemoryDependencies(client,scope,deps))add(forbidden.id,forbidden.kind,'memory_generation_forbidden');
  if(savedSkillPolicyChange){const version=await savedSkillPolicyChange(client,scope,requestId);if(version)add(version,'reply_skill','skill_policy_changed');}
  else if(request.skill_version_id!==null)throw new ReplyStoreError('reply_guards_unavailable');
  return [...changes.values()];
}
