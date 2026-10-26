/** 探索旧快照的实际来源复验；旧fingerprint按dataclass/asdict与Python JSON计算。 */
import type {Client} from 'pg';
import {createHash} from 'node:crypto';
import {readContextMessages} from '../context/reply-context-read.ts';
import {readContextMemories,memoryEvidence} from '../context/reply-context-memory.ts';
import {projectEvolution} from '../../memory/overview/projection/versions.ts';
import {normalizeEvent,normalizeConditions,normalizeEvolution} from '../../memory/overview/projection/metadata.ts';
import {blankTiming,type ContextScope,type ReplyContextEvidence} from '../context/reply-context-types.ts';
import {canonicalJSON} from '../../memory/overview/evidence/sources.ts';
import {pythonISO} from '../../memory/overview/projection/time.ts';
import {ExplorationStale,type EvidenceSnapshot,type ExplorationInput} from './exploration-contract.ts';
import {recallMemories} from '../../retrieval/retrieval-ranking.ts';
import {activeMessage} from '../generation/reply-assistant-erasure.ts';
type Row=Record<string,any>;
const reject=():never=>{throw new ExplorationStale();};
const uuid=(v:any)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const time=(v:any)=>v===null?null:pythonISO(v)!.replace('T',' ');
const json=(v:any):string=>Array.isArray(v)?'['+v.map(json).join(', ')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+': '+json(v[k])).join(', ')+'}':JSON.stringify(v);
const timing=(v:Row)=>({...v,recorded_at:time(v.recorded_at),source_started_at:time(v.source_started_at),source_ended_at:time(v.source_ended_at)});
function event(v:Row|null):Row|null {return v?{...v,occurrence_start:time(v.occurrence_start),occurrence_end:time(v.occurrence_end),occurrence_precision:v.occurrence_precision??'unknown',occurrence_expression:v.occurrence_expression??null,anchor_message_id:v.anchor_message_id??null,source_current:true}:null;}
function evolution(v:Row|null,stored?:Row|null):Row|null {if(!v)return null;return {kind:v.kind,explanation:v.explanation,related_versions:v.related_versions.map((r:Row)=>[r.memory_id,r.revision]),evidence_message_ids:v.evidence_message_ids,source_supported:v.source_supported,claim_changed:v.claim_changed,condition_changed:v.condition_changed,proof:v.proof??null,source_current:true,projected:stored!==undefined,stored_evolution:stored===undefined?null:evolution(stored)};}
function normalizedSnapshot(v:unknown):Row {
 if(!v||typeof v!=='object'||Array.isArray(v))reject();const row=v as Row;
 const base=['evidence_id','kind','text','source_ids','fingerprint','manual_contact'],additions=[[],['timing','valid_at','invalid_at'],['timing','valid_at','invalid_at','event'],['timing','valid_at','invalid_at','event','conditions'],['timing','valid_at','invalid_at','event','conditions','evolution'],['timing','valid_at','invalid_at','event','conditions','evolution','speaker_role']];
 if(!additions.some(keys=>[...base,...keys].sort().join()===Object.keys(row).sort().join())||!uuid(row.evidence_id)||!['message','confirmed_memory'].includes(row.kind)||typeof row.text!=='string'||!row.text.trim()||[...row.text].length>(row.kind==='message'?1500:300)||!Array.isArray(row.source_ids)||!row.source_ids.length||!row.source_ids.every(uuid)||typeof row.fingerprint!=='string'||row.fingerprint.length!==64||typeof row.manual_contact!=='boolean'||row.manual_contact&&row.kind!=='confirmed_memory')reject();
 const result={...row,timing:row.timing??blankTiming(),valid_at:row.valid_at??null,invalid_at:row.invalid_at??null,event:normalizeEvent(row.event),conditions:normalizeConditions(row.conditions),evolution:normalizeEvolution(row.evolution),speaker_role:row.speaker_role??'unknown'};
 if(!['owner','contact','system','unknown'].includes(result.speaker_role)||row.kind!=='message'&&result.speaker_role!=='unknown')reject();
 if(result.evolution)delete result.evolution.proof;if(row.kind!=='message')delete (result as Row).speaker_role;return result;
}

async function readSnapshot(client:Client,scope:ContextScope,snapshot:Row):Promise<{actual:EvidenceSnapshot;current:ReplyContextEvidence}> {
 let current:ReplyContextEvidence|undefined,payload:Row,manual=false;
  if(snapshot.kind==='message'){
   current=(await readContextMessages(client,scope,{ids:[snapshot.evidence_id],limit:1}))[0];if(!current)reject();
   // 与旧valid_source_ids_sql的UNION聚合相同，不用TS ref行顺序替换旧来源顺序。
   const ids=(await client.query(`SELECT array_agg(source_id) AS ids FROM (SELECT ref.source_document_id AS source_id FROM message_source_ref ref WHERE ref.message_id=$1 AND ref.owner_id=$2 AND ref.contact_id=$3 AND ref.source_document_id IS NOT NULL AND EXISTS(SELECT 1 FROM source_document s WHERE s.id=ref.source_document_id AND s.owner_id=ref.owner_id AND s.contact_id=ref.contact_id AND s.status='active') UNION SELECT ref.observation_id AS source_id FROM message_source_ref ref WHERE ref.message_id=$1 AND ref.owner_id=$2 AND ref.contact_id=$3 AND ref.observation_id IS NOT NULL) refs`,[snapshot.evidence_id,scope.owner_id,scope.contact_id])).rows[0].ids;
   payload={scope,text:current!.text,source_ids:ids,status:'active',valid_at:null,invalid_at:null,role:current!.speaker_role,occurred_at:time(current!.timing.source_started_at),session_id:null};
  }else{
   const row=(await readContextMemories(client,scope,'confirmed_memory',[snapshot.evidence_id]))[0];if(!row)reject();current=memoryEvidence(row,scope,'confirmed_memory');manual=row.adoption_method==='manual';
   const raw=(await client.query('SELECT to_jsonb(m) AS value FROM confirmed_memory m WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[scope.owner_id,scope.contact_id,snapshot.evidence_id])).rows[0]?.value;if(!raw)reject();
   const projected=await projectEvolution(client,raw);
   payload={scope,text:row.text,source_ids:row.source_ids,status:row.status,valid_at:time(row.valid_at),invalid_at:time(row.invalid_at),revision:row.revision,adoption_method:row.adoption_method,category:row.category,topic:row.topic,timing:timing(row.timing),event:event(row.event),conditions:row.conditions?{items:row.conditions.items,source_current:true}:null,evolution:evolution(projected.current,projected.current!==projected.stored?projected.stored:undefined)};
  }
  const hash=createHash('sha256').update(json(payload!)).digest('hex');
  const actual={evidence_id:current!.evidence_id,kind:current!.kind,text:[...current!.text].slice(0,current!.kind==='message'?1500:300).join(''),source_ids:payload!.source_ids,fingerprint:hash,manual_contact:manual,timing:current!.timing,valid_at:current!.valid_at,invalid_at:current!.invalid_at,event:current!.event,conditions:current!.conditions,evolution:current!.evolution,speaker_role:current!.speaker_role};

 if(actual.kind!=='message')delete (actual as Row).speaker_role;return {actual:actual as EvidenceSnapshot,current:current!};
}
/** B证据遵守原最小窗口；额外完整材料只用于删除依赖。 */
export class ExplorationEvidence {
 restore(_scope:ContextScope,values:unknown):EvidenceSnapshot[]{
  if(!Array.isArray(values)||values.length>14)reject();const result=(values as unknown[]).map(normalizedSnapshot) as EvidenceSnapshot[];if(new Set(result.map(s=>s.evidence_id)).size!==result.length)reject();return result;
 }
 dependencies(values:readonly EvidenceSnapshot[],scope?:ContextScope):string[]{return [...new Set(values.flatMap(s=>[s.evidence_id,...s.source_ids.filter(id=>!s.manual_contact||id!==scope?.contact_id),...(s.evolution?.evidence_message_ids??[])]))].sort();}
 async validate(client:Client,scope:ContextScope,values:readonly EvidenceSnapshot[]):Promise<void>{
  for(const item of values){const snapshot=this.restore(scope,[item])[0];const {actual}=await readSnapshot(client,scope,snapshot);if(canonicalJSON(actual)!==canonicalJSON(snapshot))reject();}
 }
 async generation_dependencies(client:Client,scope:ContextScope,values:readonly EvidenceSnapshot[]):Promise<ReplyContextEvidence[]>{
  const result:ReplyContextEvidence[]=[];for(const item of values){const snapshot=this.restore(scope,[item])[0];const {actual,current}=await readSnapshot(client,scope,snapshot);if(canonicalJSON(actual)!==canonicalJSON(snapshot))reject();result.push({...current,selection_reason:'本次意愿的实际删除依赖，不扩展生成模型材料。',model_visible:false});}return result;
 }
 async capture(client:Client,scope:ContextScope,content:ExplorationInput):Promise<EvidenceSnapshot[]>{
  let ids:string[]=[],query=content.purpose_hint??'';
  if(content.type==='response_exploration'){
   const target=(await readContextMessages(client,scope,{ids:[content.target_message_id!],limit:1}))[0];if(!target)reject();query=target.text;
   const anchor=(await client.query('SELECT occurred_at::text FROM message WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[scope.owner_id,scope.contact_id,content.target_message_id])).rows[0];if(!anchor)reject();
   const values=[scope.owner_id,scope.contact_id,content.target_message_id,anchor.occurred_at];
   const before=anchor.occurred_at===null?'message.occurred_at IS NULL AND message.id<$3':'message.occurred_at IS NOT NULL AND (message.occurred_at<$4::timestamptz OR message.occurred_at=$4::timestamptz AND message.id<$3)';
   const after=anchor.occurred_at===null?'message.occurred_at IS NULL AND message.id>$3':'(message.occurred_at IS NULL OR message.occurred_at>$4::timestamptz OR message.occurred_at=$4::timestamptz AND message.id>$3)';
   // 显式类型绑定也覆盖无时间锚点，避免未使用参数类型推断失败。
   const adjacent=async(condition:string,order:string)=>(await client.query(`SELECT message.id FROM message WHERE owner_id=$1 AND contact_id=$2 AND id<>$3 AND ($4::timestamptz IS NULL OR true) AND ${activeMessage} AND ${condition} ORDER BY message.occurred_at ${order} NULLS LAST,message.id ${order} LIMIT 2`,values)).rows.map(r=>r.id);
   ids=[content.target_message_id!,...(await adjacent(before,'DESC')).reverse(),...await adjacent(after,'ASC')];
  }else ids=(await readContextMessages(client,scope,{limit:5})).reverse().map(e=>e.evidence_id);
  const memories=recallMemories(await readContextMemories(client,scope,'confirmed_memory') as any[],[...query].slice(0,500).join(''),2);
  const selected=[...ids.map(evidence_id=>({evidence_id,kind:'message'})),...memories.map(r=>({evidence_id:r.id,kind:'confirmed_memory'}))];
  const result:EvidenceSnapshot[]=[];for(const item of selected){const {actual}=await readSnapshot(client,scope,item);result.push(actual);}return result;
 }
}
