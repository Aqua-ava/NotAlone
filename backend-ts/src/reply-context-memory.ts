import {protectCandidate} from './memory-mutations-protection.ts';
import type {Client} from 'pg';
import {activeRef,canonicalJSON,digest,decisionAvailable,validateFrozen,captureSnapshot} from './contact-overview-evidence.ts';
import {projectTiming,pythonISO,epochMicros} from './contact-overview-time.ts';
import {normalizeEvent,normalizeConditions} from './contact-overview-metadata.ts';
import {projectEvolution} from './contact-overview-versions.ts';
import {dimensionSourcesCurrent,candidateDigest} from './contact-overview-dimensions.ts';
import {recallMemories,mergeMemoryRecalls} from './retrieval-ranking.ts';
import {ReplyContextError,PENDING_REASON,HISTORICAL_REASON,type ContextScope,type ContextMetadata,type ReplyContextEvidence} from './reply-context-types.ts';
type Row=ContextMetadata;
export type MemoryKind='confirmed_memory'|'owner_memory'|'pending_candidate';
export function currentInterval(row:Row,expected='active',now=BigInt(Date.now())*1000n):boolean {
 return row.status===expected&&(!row.valid_at||epochMicros(row.valid_at)<=now)&&(!row.invalid_at||now<epochMicros(row.invalid_at));
}
async function sourceAvailable(client:Client,row:Row,kind:MemoryKind):Promise<boolean>{
 if(!Array.isArray(row.source_ids)||!row.source_ids.length)return false;
 if(kind==='owner_memory'&&row.source_dependency_mode!=='all'&&row.source_ids.includes(row.owner_id)){try{await ownerMemorySourceDependencies(client,row.owner_id,row);return true;}catch(error){if(error&&typeof error==='object'&&'code' in error&&!(error instanceof ReplyContextError))throw error;return false;}}
 const scope=kind==='owner_memory'?null:row.contact_id;
 const available=(await client.query(`SELECT id,contact_id,'document' AS kind FROM public.source_document WHERE owner_id=$1 AND ($2::uuid IS NULL OR contact_id=$2) AND id=ANY($3::uuid[]) AND status='active'
 UNION SELECT id,contact_id,'observation' FROM public.local_wechat_observation WHERE owner_id=$1 AND ($2::uuid IS NULL OR contact_id=$2) AND id=ANY($3::uuid[])
 UNION SELECT m.id,m.contact_id,'message' FROM public.message m WHERE m.owner_id=$1 AND ($2::uuid IS NULL OR m.contact_id=$2) AND m.id=ANY($3::uuid[]) AND EXISTS(SELECT 1 FROM public.message_source_ref ref WHERE ref.owner_id=m.owner_id AND ref.contact_id=m.contact_id AND ref.message_id=m.id AND ${activeRef})`,[row.owner_id,scope,row.source_ids])).rows;
 if(row.source_dependency_mode!=null&&!['any','all'].includes(row.source_dependency_mode))throw new ReplyContextError('来源依赖模式无效。');
 if(row.source_dependency_mode==='all')return available.length===row.source_ids.length&&new Set(row.source_ids).size===row.source_ids.length&&available.every(r=>r.kind==='message')&&new Set(available.map(r=>r.contact_id)).size===1;
 if(row.requires_all_sources)return available.length===new Set(row.source_ids).size;
 return available.length>0;
}
async function correctionAvailable(client:Client,owner:string,decision:Row):Promise<boolean>{
 const evidence=decision.evidence;
 if(evidence?.kind!=='erased_guard')return !!evidence&&await decisionAvailable(client,owner,evidence);
 if(decision.decision!=='rejected'||decision.rejected_text!==null||decision.corrected_text!==null||evidence.version!==1||!Array.isArray(evidence.canonical_ids)||!evidence.canonical_ids.length||new Set(evidence.canonical_ids).size!==evidence.canonical_ids.length||Object.keys(evidence).sort().join(',')!=='canonical_ids,kind,version')return false;
 return !!(await client.query(`SELECT 1 FROM public.message m WHERE m.owner_id=$1 AND m.contact_id=$2 AND m.id=ANY($3::uuid[]) AND EXISTS(SELECT 1 FROM public.message_source_ref ref WHERE ref.owner_id=m.owner_id AND ref.contact_id=m.contact_id AND ref.message_id=m.id AND ${activeRef}) LIMIT 1`,[owner,decision.contact_id,evidence.canonical_ids])).rowCount;
}
async function candidateProtected(client:Client,row:Row):Promise<boolean>{
 // 与旧列表相同：只读保护重建完整trace/context/人工纠错依赖，不执行写入。
 const protectedCandidate=await protectCandidate(client,row,{validateGeneration:false});
 return protectedCandidate.row.status==='pending';
}
export async function projectReplyMemoryMetadata(client:Client,row:Row,kind:MemoryKind):Promise<Row>{
 const event=normalizeEvent(row.event),conditions=normalizeConditions(row.conditions);
 let eventBound=false,conditionsBound=false;
 const candidate=kind==='pending_candidate'?row:row.source_candidate_id?(await client.query('SELECT to_jsonb(c) AS value FROM public.memory_candidate c WHERE owner_id=$1 AND id=$2',[row.owner_id,row.source_candidate_id])).rows[0]?.value:null;
 if(candidate&&(kind==='owner_memory'||candidate.contact_id===row.contact_id)){
  try{
   if(candidate.correction_evidence){await validateFrozen(client,row.owner_id,candidate.correction_evidence);if(await dimensionSourcesCurrent(client,candidate)&&await decisionAvailable(client,row.owner_id,candidate.correction_evidence)){eventBound=canonicalJSON(normalizeEvent(candidate.event))===canonicalJSON(event);conditionsBound=candidate.text_content===row.text_content&&canonicalJSON(normalizeConditions(candidate.conditions))===canonicalJSON(conditions);}}
  }catch(error){if(error&&typeof error==='object'&&'code' in error)throw error;}
 }
 const projectedEvent=event?{...event,stage_verified:event.stage_verified&&eventBound,occurrence_verified:event.occurrence_verified&&eventBound}:null;
 const projectedConditions=conditions?{...conditions,items:conditions.items.map((item:Row)=>({...item,source_supported:item.source_supported&&conditionsBound}))}:null;
 const evolution=await projectEvolution(client,row);
 let currentEvolution=evolution.current;
 if(kind==='pending_candidate'&&currentEvolution?.proof&&(currentEvolution.proof.candidate_sha256!==candidateDigest(row)||currentEvolution.proof.scope?.contact_id!==row.contact_id))currentEvolution=null;
 return {timing:await projectTiming(client,{...row,conditions},kind==='owner_memory'?'owner':'contact'),event:projectedEvent,conditions:projectedConditions,evolution:currentEvolution?Object.fromEntries(Object.entries(currentEvolution).filter(([key])=>key!=='proof')):null};
}
export async function readContextMemories(client:Client,scope:ContextScope,kind:MemoryKind,ids?:string[]):Promise<Row[]>{
 const table=kind==='pending_candidate'?'memory_candidate':kind;
 const raw=(await client.query(`SELECT to_jsonb(m) AS value FROM public.${table} m WHERE m.owner_id=$1 ${kind==='owner_memory'?'AND $2::uuid IS NOT NULL':'AND m.contact_id=$2'} AND m.status=$3 AND (m.valid_at IS NULL OR m.valid_at<=clock_timestamp()) AND (m.invalid_at IS NULL OR clock_timestamp()<m.invalid_at) AND ($4::uuid[] IS NULL OR m.id=ANY($4::uuid[])) ORDER BY m.created_at,m.id`,[scope.owner_id,scope.contact_id,kind==='pending_candidate'?'pending':'active',ids??null])).rows;
 const results:Row[]=[];
 for(const {value:row} of raw){
  if(!await sourceAvailable(client,row,kind))continue;
  if(kind==='pending_candidate'){if(!await candidateProtected(client,row))continue;}
  else {
   const decisions=(await client.query(`SELECT * FROM public.memory_correction_decision WHERE owner_id=$1 AND record_kind=$2 AND (record_id=$3 OR replacement_memory_id=$3)`,[scope.owner_id,kind==='owner_memory'?'owner_memory':'contact_memory',row.id])).rows;
   let valid=true;for(const decision of decisions)if(!await correctionAvailable(client,scope.owner_id,decision)){valid=false;break;}if(!valid)continue;
   if(row.source_candidate_id){const candidate=(await client.query('SELECT correction_evidence FROM public.memory_candidate WHERE owner_id=$1 AND id=$2',[scope.owner_id,row.source_candidate_id])).rows[0];const evidence=candidate?.correction_evidence;if(evidence&&(evidence.decision_ids?.length||evidence.has_memory_context)&&!await decisionAvailable(client,scope.owner_id,evidence))continue;}
  }
  const data=await projectReplyMemoryMetadata(client,row,kind);
  // 原行绑定状态、置信度、来源模式及原始事件；投影绑定当前来源和父版本。
  results.push({...row,...data,text:row.text_content,valid_at:pythonISO(row.valid_at),invalid_at:pythonISO(row.invalid_at),[kind==='pending_candidate'?'candidate_id':'memory_id']:row.id,freshness_sha256:digest({row,...data,sources:await captureSnapshot(client,scope.owner_id,row.source_ids,row.source_ids,kind==='owner_memory'?null:scope.contact_id)})});
 }
 return results;
}
export function pendingSelectionReason(row:Row):string {
 return `${PENDING_REASON}候选分类 ${row.category}；主题 ${row.topic||'未分类'}；置信度 ${pythonFixed2(Number(row.confidence))}；风险标记 ${(row.risk_flags??[]).join('、')||'无'}。`;
}
export function memoryEvidence(row:Row,scope:ContextScope,kind:MemoryKind):ReplyContextEvidence{
 const ranking=row.relevance_score==null?'':`与当前正文相关度 ${pythonFixed2(row.relevance_score)}；命中词 ${row.matched_terms.join('、')||'无'}；排序按相关性优先${kind==='pending_candidate'?'。':'；'}`;
 const reason=kind==='pending_candidate'?pendingSelectionReason(row)+ranking:(row.timing.current_status==='historical'?HISTORICAL_REASON:'')+ranking+(kind==='owner_memory'?'已保存的本人资料。':'已保存的联系人关系资料。');
 return {evidence_id:row.id,kind,text:row.text,scope,source_ids:row.source_ids,selection_reason:reason+row.timing.current_status_reason,status:row.status,valid_at:row.valid_at,invalid_at:row.invalid_at,revision:kind==='pending_candidate'?null:Number(row.revision),timing:row.timing,event:row.event,conditions:row.conditions,evolution:row.evolution,speaker_role:'unknown',model_visible:true,navigation:null,freshness_sha256:row.freshness_sha256};
}
export function selectContextMemories(rows:Row[],queries:string[],limit:number,charBudget:number):Row[]{
 const ranked=mergeMemoryRecalls(queries.map(query=>recallMemories(rows as any[],query,20)));
 const selected:Row[]=[];let used=0;
 for(const row of ranked){if(row.relevance_score!=null&&row.relevance_score<.15)continue;if(selected.length>=limit||used+[...row.text].length>charBudget)break;selected.push(row);used+=[...row.text].length;}
 return selected;
}

/** 对齐Python .2f 的IEEE754精确值及ties-to-even，不能直接用JS toFixed。 */
export function pythonFixed2(value:number):string {
 if(!Number.isFinite(value))throw new ReplyContextError('评分数值无效。');
 const buffer=new ArrayBuffer(8),view=new DataView(buffer);view.setFloat64(0,Math.abs(value));
 const bits=view.getBigUint64(0),exponent=Number((bits>>52n)&2047n),mantissa=(bits&((1n<<52n)-1n))+(exponent?1n<<52n:0n);
 const power=(exponent||1)-1023-52;
 let numerator=mantissa*100n,denominator=1n;if(power>=0)numerator<<=BigInt(power);else denominator<<=BigInt(-power);
 let quotient=numerator/denominator;const remainder=numerator%denominator;
 if(remainder*2n>denominator||remainder*2n===denominator&&quotient%2n===1n)quotient++;
 return (value<0||Object.is(value,-0)?'-':'')+String(quotient/100n)+'.'+String(quotient%100n).padStart(2,'0');
}
export async function ownerMemorySourceDependencies(client:Client,owner:string,row:Row):Promise<string[]> {
 if(row.owner_id!==owner||!Array.isArray(row.source_ids))throw new ReplyContextError('本人来源范围无效。');
 if(row.source_dependency_mode==='all'){if(!await sourceAvailable(client,row,'owner_memory'))throw new ReplyContextError('本人ALL来源须全部为同范围活动消息。');return [...row.source_ids];}
 let sources:string[]=[...row.source_ids];
 if(sources.includes(owner)){
  let current=row;const visited=new Set<string>();let found=false;
  for(let i=0;i<100;i++){
   if(!current||visited.has(current.id)||current.owner_id!==owner||current.status==='deleted'||current.adoption_method!=='manual'||!current.source_ids.includes(owner))throw new ReplyContextError('本人手录根已失效。');
   visited.add(current.id);
   if(!current.supersedes_memory_id){if(current.source_candidate_id||canonicalJSON(current.source_ids)!==canonicalJSON([owner]))throw new ReplyContextError('本人手录根无效。');found=true;break;}
   current=(await client.query('SELECT to_jsonb(m) AS value FROM public.owner_memory m WHERE owner_id=$1 AND id=$2',[owner,current.supersedes_memory_id])).rows[0]?.value;
  }
  if(!found)throw new ReplyContextError('本人手录根循环或超界。');
  sources=sources.filter(id=>id!==owner);
 }
 if(sources.length&&!await sourceAvailable(client,{...row,source_ids:sources,requires_all_sources:true},'owner_memory'))throw new ReplyContextError('本人资料原始来源已不可用。');
 return sources;
}
