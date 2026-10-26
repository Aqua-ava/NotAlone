/** 探索旧快照的实际来源复验；旧fingerprint按dataclass/asdict与Python JSON计算。 */
import type {Client} from 'pg';
import {createHash} from 'node:crypto';
import {readContextMessages} from '../context/reply-context-read.ts';
import {readContextMemories,memoryEvidence} from '../context/reply-context-memory.ts';
import {projectEvolution} from '../../memory/overview/contact-overview-versions.ts';
import {normalizeEvent,normalizeConditions,normalizeEvolution} from '../../memory/overview/contact-overview-metadata.ts';
import {blankTiming,type ContextScope,type ReplyContextEvidence} from '../context/reply-context-types.ts';
import {canonicalJSON} from '../../memory/overview/contact-overview-evidence.ts';
import {pythonISO} from '../../memory/overview/contact-overview-time.ts';
import {ReplyStoreError} from '../generation/reply-store.ts';
type Row=Record<string,any>;
const reject=():never=>{throw new ReplyStoreError('exploration_stale');};
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
 if(result.evolution)delete result.evolution.proof;return result;
}
/** 返回完整当前证据，仅供删除依赖；调用方不应把该额外材料提升为可见证据。 */
export async function requireExplorationEvidence(client:Client,scope:ContextScope,values:unknown):Promise<ReplyContextEvidence[]> {
 if(!Array.isArray(values)||values.length>14)reject();const snapshots=(values as unknown[]).map(normalizedSnapshot);if(new Set(snapshots.map(s=>s.evidence_id)).size!==snapshots.length)reject();
 const result:ReplyContextEvidence[]=[];
 for(const snapshot of snapshots){let current:ReplyContextEvidence|undefined,payload:Row,manual=false;
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
  if(canonicalJSON(actual)!==canonicalJSON(snapshot))reject();result.push({...current!,selection_reason:'本次意愿的实际删除依赖，不扩展生成模型材料。',model_visible:false});
 }
 return result;
}
