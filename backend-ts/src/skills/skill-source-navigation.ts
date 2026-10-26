/** 审核导航只沿原记忆锚点核验；记录摘要沿 Python 的字段与空格编码。 */
import type {Client} from 'pg';
import {canonicalJSON,parseStoredJSON,readLineage,activeRef} from '../memory/overview/evidence/sources.ts';
import {SkillPortError,skillDigest} from './skill-execution-view.ts';
import {skillOwnerLineage} from './skill-source-owner-lineage.ts';
import type {SkillRow} from './skill-execution-view.ts';
const CONTACT_COLUMNS=`id AS memory_id,owner_id,contact_id,text_content AS memory_text,category AS memory_category,topic AS memory_topic,source_ids AS memory_source_ids,source_candidate_id,adoption_method,status AS memory_status,valid_at,invalid_at,revision,confidence AS memory_confidence,risk_flags AS memory_risk_flags,supersedes_memory_id,event AS memory_event,conditions AS memory_conditions,evolution AS memory_evolution,version_evidence,retirement_reason,retired_at,source_dependency_mode AS memory_dependency_mode,requires_all_sources AS memory_requires_all_sources,created_at AS recorded_at`;
const OWNER_COLUMNS=`id AS memory_id,owner_id,text_content,category,topic,source_ids,adoption_method,status,valid_at,invalid_at,revision,confidence,risk_flags,source_candidate_id,supersedes_memory_id,event AS memory_event,conditions AS memory_conditions,evolution AS memory_evolution,version_evidence,retirement_reason,retired_at,source_dependency_mode AS dependency_mode,requires_all_sources,created_at AS recorded_at`;
function dates(row:SkillRow){for(const key of ['valid_at','invalid_at','retired_at','recorded_at'])if(typeof row[key]==='string')row[key]=row[key].replace('T',' ').replace(/([+-]\d{2})$/,'$1:00').replace(/\.(\d+)(?=[+-])/,(_,digits:string)=>'.'+digits.padEnd(6,'0'));return row;}
export async function captureSkillNavigation(client:Client,owner:string,contact:string,navigation:SkillRow[]){
 if(!Array.isArray(navigation))throw new SkillPortError();const result:SkillRow[]=[];
 for(const identity of navigation){
  if(!['contact','owner'].includes(identity.scope_kind))throw new SkillPortError();const own=identity.scope_kind==='owner',table=own?'owner_memory':'confirmed_memory';
  const selected=await client.query(`SELECT to_jsonb(projection)::text AS record FROM (SELECT ${own?OWNER_COLUMNS:CONTACT_COLUMNS} FROM public.${table} WHERE owner_id=$1 AND id=$2 ${own?'':'AND contact_id=$3'}) projection`,own?[owner,identity.memory_id]:[owner,identity.memory_id,contact]);
  if(!selected.rows.length)throw new SkillPortError();const plain=JSON.parse(selected.rows[0].record),row=dates(parseStoredJSON(selected.rows[0].record));
  if(!['active','invalidated'].includes(own?plain.status:plain.memory_status)||plain.revision!==identity.memory_revision)throw new SkillPortError();
  const confidenceKey=own?'confidence':'memory_confidence';
  // PG to_jsonb 将 1.0 写作 1；原 psycopg 直接列投影保留 double 的 Python float 表示。
  if(Number.isInteger(plain[confidenceKey]))row[confidenceKey]=parseStoredJSON(String(plain[confidenceKey])+'.0');
  const raw=(await client.query(`SELECT *,valid_at::text AS valid_at,invalid_at::text AS invalid_at FROM public.${table} WHERE owner_id=$1 AND id=$2`,[owner,identity.memory_id])).rows[0];
  const lineage=own?await skillOwnerLineage(client,owner,raw):await readLineage(client,owner,contact,raw);
  if(canonicalJSON([...lineage.source_ids].sort())!==canonicalJSON([...identity.dependency_ids].sort()))throw new SkillPortError();
  result.push({identity,record_sha256:skillDigest(row),generation_sha256:lineage.generation_sha256});
 }
 return result;
}
