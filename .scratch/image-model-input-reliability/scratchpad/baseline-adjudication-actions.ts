/** 裁决只消费被冻结的候选、正式版本和消息；模型结果本身不授予写入资格。 */
import {randomUUID} from 'node:crypto';
import {sha256} from '../../../platform/sha256.ts';
import {StorageFailure,type StorageAction,type StorageLease,type StorageRow,type StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {assertSourceEligibility} from '../../../history/sqlite/source.ts';
import {assertTaskContributions} from '../qualification.ts';
import {verifiedExtractionOutput} from '../outputs.ts';
import {validateModelLedgerReceipt,type ModelLedgerReceipt} from '../../../platform/models/model-ledger-contract.ts';
import type {ModelTaskClaim} from '../../../platform/models/model-permit-port.ts';
import type {AdjudicationItem,AdjudicationSource,SimilarMemory} from '../../adoption/contracts.ts';
import {requireImageCitation} from '../content-citation.ts';
import {parseAdjudications,parseRelations,mergeResult} from '../../adoption/adjudication-dsh.ts';
import {readExtractionToolArguments} from '../../extraction/arguments.ts';
import {AMBIGUITY_NOTE} from '../../extraction/bounded.ts';
import {AMBIGUITY_UNCONFIRMED,unconfirmedAmbiguity} from '../../extraction/ambiguity-guard.ts';
import {applyDecision,recordCandidateGate,retireMergedParents} from './actions.ts';
import {sourceVerificationState} from './evidence.ts';
import {memoryTimeEligibility} from './temporal.ts';
import {available,fail,id,requireAutomaticCandidate,requireVersion,requireSources} from './qualification.ts';
import {qualificationSources,mergeKnowledgeSources} from './dependencies.ts';
import type {SqliteAdjudicationModelPurpose} from './model-port.ts';
const purposes=['adjudication','relation_verification','merge_verification'] as const;
const digest=(value:unknown)=>sha256(JSON.stringify(value,(_key,v)=>typeof v==='bigint'?v.toString():v));
interface Basis {pageIndex:number;candidateId:string;candidateRevision:string;runId:string;taskId:string;scopeKind:'self'|'contact';contactId:string|null;memoryRevision:string;intentRevision:string;eventTimeUnverified?:1;item:AdjudicationItem;parents:{id:string;versionNo:string;headRevision:string;protected:boolean}[];}
export interface AdjudicationClaim {attemptId:string;stepId:string;basis:Basis;claim:ModelTaskClaim;}
const act=(name:string,mode:'read'|'write',execute:(tx:StorageTransaction,input:unknown,lease:StorageLease)=>unknown):StorageAction=>({name:`memoryAdjudication.${name}`,mode,retryBusy:mode==='write',execute} as StorageAction);
/** 候选最近一次已记录裁决结果所依据的冻结快照，与当前快照（忽略控制修订与分页）是否一致。 */
function decidedWithSameBasis(tx:StorageTransaction,ownerId:string,candidateId:string,basis:Basis):boolean {
 const prior=tx.get(`SELECT b.payload FROM execution_event r JOIN step_attempt a ON a.owner_id=r.owner_id AND a.id=r.step_attempt_id
  JOIN step_input i ON i.owner_id=a.owner_id AND i.step_id=a.step_id AND i.candidate_id=?
  JOIN execution_event b ON b.owner_id=a.owner_id AND b.step_attempt_id=a.id AND b.kind='adjudication_basis'
  WHERE r.owner_id=? AND r.kind='adjudication_result' ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`,[candidateId,ownerId]);
 if(!prior)return false;
 const normalize=(value:Basis)=>digest({...value,intentRevision:'0',pageIndex:0});
 return normalize(JSON.parse(String(prior.payload)) as Basis)===normalize(basis);
}
/** 本任务目标资料是否仍被未知回执的裁决类调用占位；占位按整轮目标资料登记，与具体候选无关。 */
function unknownOccupancy(tx:StorageTransaction,ownerId:string,taskId:string):boolean {
 return !!tx.get(`SELECT 1 FROM task_contribution t JOIN run_input i ON i.owner_id=t.owner_id AND i.run_id=t.run_id AND i.source_contact_id=t.source_contact_id AND i.role='target'
  JOIN operation_item oi ON oi.owner_id=i.owner_id AND oi.item_id=i.item_id AND oi.state='unknown' AND oi.effect_kind IN ('adjudication','relation_verification','merge_verification')
  WHERE t.owner_id=? AND t.task_id=? LIMIT 1`,[ownerId,taskId]);
}
/** 失败事件只保留供应商失败的稳定分类；形状不符时直接忽略，不让诊断信息阻断失败收尾。 */
function failureProvider(value:unknown):{name:string;code:string;status?:number}|undefined {
 const v=value as {name?:unknown;code?:unknown;status?:unknown}|null|undefined;
 if(!v||typeof v!=='object'||(v.name!=='LlmError'&&v.name!=='LlmFailure')||typeof v.code!=='string'||!/^[A-Za-z0-9_.:-]{1,80}$/.test(v.code))return undefined;
 const status=typeof v.status==='number'&&Number.isSafeInteger(v.status)&&v.status>=100&&v.status<=599?v.status:undefined;
 return {name:v.name,code:v.code,...(status===undefined?{}:{status})};
}
function revision(tx:StorageTransaction,ownerId:string,scopeKind:string,contactId:string|null):bigint {
 const r=scopeKind==='self'?tx.get('SELECT memory_revision FROM owner WHERE owner_id=?',[ownerId]):tx.get('SELECT memory_revision FROM contact WHERE owner_id=? AND id=?',[ownerId,contactId]);
 return r?.memory_revision as bigint??fail('memory_scope_stale');
}
function sources(tx:StorageTransaction,ownerId:string,parent:{candidateId?:string;memoryId?:string;versionNo?:bigint}):AdjudicationSource[] {
 const rows=requireSources(tx,ownerId,parent,!!parent.memoryId&&tx.get('SELECT adoption_mode FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,parent.memoryId,parent.versionNo!])?.adoption_mode==='manual');
 return rows.map(r=>{
  const occurredAt=tx.get('SELECT sent_at FROM message WHERE owner_id=? AND contact_id=? AND id=?',[ownerId,r.source_contact_id,r.message_id])?.sent_at;
  const base={message_id:String(r.message_id),occurred_at:occurredAt==null?null:new Date(Number(occurredAt)).toISOString()};
  return r.content_kind==='image'?{...base,text:null,content_kind:'image' as const,
   content_ref:requireImageCitation(tx,ownerId,String(r.source_contact_id),String(r.message_id),r.content_ref_json),
   observation:{kind:'model_observation' as const,text:String(r.explanation??'')}}:
   {...base,text:[...String(r.text_body)].slice(Number(r.span_start),Number(r.span_end)).join('')};
 });
}
/** 旧关系核验只认证逐字文字；图像比较保留候选，不能把观察描述当原文签证。 */
export function requiresMultimodalRelationReview(item:AdjudicationItem):boolean {
 return item.similar.length>0&&[...item.candidate_source_texts,...item.similar.flatMap(parent=>parent.source_texts)].some(source=>source.content_kind==='image');
}
function versionFact(tx:StorageTransaction,ownerId:string,v:StorageRow):Record<string,any>|null {
 const event=tx.get(`SELECT e.payload FROM decision_candidate dc JOIN memory_candidate c ON c.owner_id=dc.owner_id AND c.id=dc.candidate_id JOIN execution_event e ON e.owner_id=c.owner_id AND e.id=c.event_id WHERE dc.owner_id=? AND dc.decision_id=? ORDER BY c.id LIMIT 1`,[ownerId,v.decision_id]);
 return event?JSON.parse(String(event.payload)).fact:null;
}
function freeze(tx:StorageTransaction,ownerId:string,candidateId:string):Basis {
 const c=tx.get('SELECT * FROM memory_candidate WHERE owner_id=? AND id=?',[ownerId,candidateId]);if(!c)fail('memory_candidate_stale');requireAutomaticCandidate(tx,ownerId,c!);
 const output=verifiedExtractionOutput(tx,{ownerId,eventId:String(c!.event_id)});
 const task=tx.get(`SELECT t.*,r.intent_revision,r.pause_requested_at FROM step_attempt a JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id JOIN processing_run r ON r.owner_id=t.owner_id AND r.id=t.run_id WHERE a.owner_id=? AND a.id=?`,[ownerId,c!.produced_attempt_id])!;
 if(task.pause_requested_at!==null)fail('memory_adjudication_paused');
 const scopeKind=c!.scope_kind as 'self'|'contact',contactId=c!.contact_id as string|null;available(tx,ownerId,{scopeKind,contactId},true);
 const fact=output.fact;
 // 事件标注不可核实属可选信息：丢弃标注、正文继续（现行规格第 4 条），并在采纳历史留 time_unverified 痕。
 const eventTimeUnverified=fact.event&&(!fact.event.stage_verified||!fact.event.occurrence_verified&&fact.event.occurrence_start!==null)?1:undefined;
 const effectiveFact=eventTimeUnverified?{...fact,event:null}:fact;
 // 前置门槛只保证数据正确性：时间不合格、整组都是未决指代、条件无来源支持；
 // 自由文本 alternatives 属不确定性表达，不再新增人工审核门，采纳时留 adopted_with_alternatives 痕。
 if(memoryTimeEligibility(tx,ownerId,{candidateId})!=='eligible'||effectiveFact.alternatives?.length&&effectiveFact.alternatives.every((x:any)=>x===AMBIGUITY_NOTE)||effectiveFact.conditions?.items.some((x:any)=>x.source_supported!==true))fail('memory_conditions_pending');
 // 代码层兜底：模型没有标注 alternatives、正文却含易歧义结构时，不再进入裁决与自动采纳，直接降级待确认。
 const ambiguity=unconfirmedAmbiguity({text:String(effectiveFact.text??''),interpretationReason:effectiveFact.interpretation_reason,alternatives:effectiveFact.alternatives});
 if(ambiguity)fail(AMBIGUITY_UNCONFIRMED);
 const memories=tx.all("SELECT * FROM memory WHERE owner_id=? AND scope_kind=? AND contact_id IS ? AND state IN ('active','withdrawn') ORDER BY id",[ownerId,scopeKind,contactId]);
 const parents:Basis['parents']=[],similar:SimilarMemory[]=[];
 for(const m of memories){
  const v=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,m.id,m.current_version_no]);if(!v)fail('memory_head_conflict');
  if(memoryTimeEligibility(tx,ownerId,{memoryId:String(m.id),versionNo:v!.version_no as bigint})!=='eligible')continue;
  let prior:Record<string,any>|null,textSources:AdjudicationSource[];
  try{
   requireVersion(tx,ownerId,m,v!);
   prior=versionFact(tx,ownerId,v!);textSources=sources(tx,ownerId,{memoryId:String(m.id),versionNo:v!.version_no as bigint});
  }catch(error){
   // 自动采纳的有效记忆若来源已不是当前有效来源（如旧绑定副本退出），它不再是可信的比较对象：只跳过它，
   // 不能让同范围所有候选都因它而无法裁决。已撤回或人工保护的资料仍须按原样阻断，避免被无声绕过。
   if(error instanceof StorageFailure&&error.code==='memory_source_stale'&&m.state==='active'&&m.manual_protection!==1n)continue;
   throw error;
  }
  parents.push({id:String(m.id),versionNo:String(v!.version_no),headRevision:String(m.head_revision),protected:m.manual_protection===1n||m.state==='withdrawn'});
  similar.push({memory_id:String(m.id),revision:String(v!.version_no),text:String(v!.body),category:prior?.category??'user_memory',topic:prior?.topic??'',subject:scopeKind==='self'?'self':'contact',adoption_method:v!.adoption_mode==='auto'&&m.state==='active'&&sourceVerificationState(tx,ownerId,{memoryId:String(m.id),versionNo:v!.version_no as bigint})==='verified'?'auto':'manual',source_message_ids:[...new Set(textSources.map(s=>s.message_id))],source_texts:textSources,statement_time:textSources.map(s=>s.occurred_at).filter((s):s is string=>s!==null).sort().at(-1)??null,valid_at:prior?.valid_at??null,invalid_at:prior?.invalid_at??null,event:prior?.event??null,conditions:prior?.conditions??null,source_receipt:digest(textSources),source_dependency_mode:prior?.source_dependency_mode??'all',requires_all_sources:prior?.requires_all_sources??true});
 }
 const candidateSources=sources(tx,ownerId,{candidateId});
 // 关系核验只认证逐字文字：文字候选不与“主题明确不同”的图片来源记忆比较，免得池里一条图片记忆拦下之后所有候选；
 // 候选自身含图片，或主题相同、缺失而无法证明无关时，仍保留比较并交由待确认。
 const candidateHasImage=candidateSources.some(source=>source.content_kind==='image');
 const comparable=candidateHasImage?similar:similar.filter(memory=>!memory.source_texts.some(source=>source.content_kind==='image')||!memory.topic||!fact.topic||memory.topic===fact.topic);
 const item:AdjudicationItem={candidate_index:0,candidate:effectiveFact,candidate_source_receipt:digest(candidateSources),candidate_source_texts:candidateSources,relation_source_receipt:digest({candidateSources,similar:comparable}),similar:comparable};
 return {pageIndex:0,candidateId,candidateRevision:String(c!.state_revision),runId:String(task.run_id),taskId:String(task.id),scopeKind,contactId,memoryRevision:String(revision(tx,ownerId,scopeKind,contactId)),intentRevision:String(task.intent_revision),...(eventTimeUnverified?{eventTimeUnverified}:{}),item,parents};
}
function record(tx:StorageTransaction,ownerId:string,attemptId:string,kind:string,payload:unknown,callId?:string,reused=false,pageOnly=false):string {
 const a=tx.get('SELECT step_id FROM step_attempt WHERE owner_id=? AND id=?',[ownerId,attemptId]);if(!a)fail('memory_adjudication_stale');
 const eventId=randomUUID(),n=tx.get('SELECT coalesce(max(event_no),0)+1 AS n FROM execution_event WHERE owner_id=? AND step_attempt_id=?',[ownerId,attemptId])!.n;
 tx.run('INSERT INTO execution_event(owner_id,id,step_attempt_id,event_no,kind,originated_call_id,reused_call_id,payload,created_at) VALUES(?,?,?,?,?,?,?,?,?)',[ownerId,eventId,attemptId,n,kind,reused?null:callId??null,reused?callId??null:null,JSON.stringify(payload),Date.now()]);
 let presentedMemories=new Set<string>(),messageIds=new Set<string>();
 if(pageOnly){
  const request=kind==='adjudication_input'?payload:JSON.parse(String(tx.get("SELECT payload FROM execution_event WHERE owner_id=? AND originated_call_id=? AND kind='adjudication_input'",[ownerId,callId!])!.payload));
  const value=JSON.parse((request as {user:string}).user);
  const prior=Array.isArray(value)?value.flatMap(v=>v.sources.prior):value.existing_memories??value.candidate_and_parents.sources.prior;
  const candidate=Array.isArray(value)?value.flatMap(v=>v.sources.candidate):value.new_memories?value.new_memories.flatMap((v:any)=>v.source_texts):value.candidate_and_parents.sources.candidate;
  presentedMemories=new Set(prior.map((m:any)=>m.memory_id));messageIds=new Set([...candidate,...prior.flatMap((m:any)=>m.sources)].map((s:any)=>s.message_id));
 }
 const selected=tx.all('SELECT * FROM step_input WHERE owner_id=? AND step_id=? ORDER BY input_no',[ownerId,a!.step_id]).filter(i=>!pageOnly||i.kind==='candidate'||i.kind==='memory'&&presentedMemories.has(String(i.memory_id))||i.kind==='message'&&messageIds.has(String(i.message_id)));
 for(const [index,input] of selected.entries()){
  tx.run('INSERT INTO execution_input(owner_id,event_id,input_no,role,presentation_no,planned_step_id,planned_input_no) VALUES(?,?,?,?,?,?,?)',[ownerId,eventId,index+1,kind==='adjudication_result'&&input.kind==='memory'?((payload as any)?.parentMemoryIds?.includes(input.memory_id)?'parent_memory':'comparison_memory'):input.kind,index+1,a!.step_id,input.input_no]);
  if(input.kind==='message')tx.run('INSERT OR IGNORE INTO event_source VALUES(?,?,?,?)',[ownerId,eventId,input.source_contact_id,input.record_id]);
 }
 return eventId;
}
function makeStep(tx:StorageTransaction,ownerId:string,basis:Basis,kind:SqliteAdjudicationModelPurpose,lease:StorageLease):AdjudicationClaim {
 const stepId=randomUUID(),attemptId=randomUUID(),task=tx.get('SELECT * FROM processing_task WHERE owner_id=? AND id=?',[ownerId,basis.taskId])!;
 if((task.resume_no as bigint)>BigInt(Number.MAX_SAFE_INTEGER))fail('memory_adjudication_revision_limit');
 const n=tx.get('SELECT coalesce(max(step_no),0)+1 AS n FROM processing_step WHERE owner_id=? AND task_id=?',[ownerId,basis.taskId])!.n;
 tx.run("INSERT INTO processing_step(owner_id,id,task_id,step_no,kind,state,input_state,successful_attempt_id,accepted_memory_revision) VALUES(?,?,?,?,?,'running','frozen',NULL,?)",[ownerId,stepId,basis.taskId,n,kind,BigInt(basis.memoryRevision)]);
 let inputNo=0;
 tx.run("INSERT INTO step_input(owner_id,step_id,input_no,kind,candidate_id,accepted_state_revision) VALUES(?,?,?,'candidate',?,?)",[ownerId,stepId,++inputNo,basis.candidateId,BigInt(basis.candidateRevision)]);
 for(const p of basis.parents)tx.run("INSERT INTO step_input(owner_id,step_id,input_no,kind,memory_id,memory_version_no,accepted_head_revision) VALUES(?,?,?,'memory',?,?,?)",[ownerId,stepId,++inputNo,p.id,BigInt(p.versionNo),BigInt(p.headRevision)]);
 const dependencies=mergeKnowledgeSources(qualificationSources(tx,ownerId,{candidateId:basis.candidateId}),...basis.parents.map(p=>qualificationSources(tx,ownerId,{memoryId:p.id,versionNo:BigInt(p.versionNo)})),...requireSources(tx,ownerId,{candidateId:basis.candidateId}).map(r=>[{contactId:String(r.source_contact_id),messageId:String(r.message_id),recordId:String(r.record_id),acceptedRevision:r.accepted_revision as bigint}]),...basis.parents.map(p=>requireSources(tx,ownerId,{memoryId:p.id,versionNo:BigInt(p.versionNo)},true).map(r=>({contactId:String(r.source_contact_id),messageId:String(r.message_id),recordId:String(r.record_id),acceptedRevision:r.accepted_revision as bigint}))));
 for(const source of dependencies)tx.run("INSERT INTO step_input(owner_id,step_id,input_no,kind,source_contact_id,message_id,record_id,accepted_revision) VALUES(?,?,?,'message',?,?,?,?)",[ownerId,stepId,++inputNo,source.contactId,source.messageId,source.recordId,source.acceptedRevision]);
 tx.run("INSERT INTO step_attempt VALUES(?,?,?,1,?,?,?,?,?,'running',?,NULL,NULL)",[ownerId,attemptId,stepId,task.resume_no,randomUUID(),Date.now()+300_000,task.control_revision,lease.runtimeId,Date.now()]);
 record(tx,ownerId,attemptId,'adjudication_basis',basis);
 return {attemptId,stepId,basis,claim:{task_id:basis.taskId,step_id:stepId,step_name:kind,worker_id:lease.runtimeId,lease_generation:Number(task.resume_no)}};
}
function current(tx:StorageTransaction,ownerId:string,attemptId:string,lease:StorageLease) {
 const a=tx.get("SELECT a.*,s.kind,s.accepted_memory_revision,t.control_revision,t.run_id,t.id AS task_id FROM step_attempt a JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE a.owner_id=? AND a.id=? AND a.state='running' AND s.state='running' AND t.state IN ('succeeded','awaiting_decision')",[ownerId,attemptId]);
 if(!a||a.runtime_token!==lease.runtimeId||BigInt(Date.now())>(a.lease_expires_at as bigint)||a.accepted_control_revision!==a.control_revision)return fail('memory_adjudication_stale');
 const event=tx.get("SELECT payload FROM execution_event WHERE owner_id=? AND step_attempt_id=? AND kind='adjudication_basis'",[ownerId,attemptId]);if(!event)fail('memory_adjudication_stale');const basis=JSON.parse(String(event!.payload)) as Basis;
 if(BigInt(basis.memoryRevision)!==a.accepted_memory_revision||revision(tx,ownerId,basis.scopeKind,basis.contactId)!==a.accepted_memory_revision)fail('memory_head_conflict');
 assertTaskContributions(tx,ownerId,basis.runId,basis.taskId);
 const fresh={...freeze(tx,ownerId,basis.candidateId),pageIndex:basis.pageIndex};if(digest(fresh)!==digest(basis))fail('memory_adjudication_stale');
 for(const s of tx.all("SELECT * FROM step_input WHERE owner_id=? AND step_id=? AND kind='message'",[ownerId,a.step_id])){
  assertSourceEligibility(tx,{owner_id:ownerId,contact_id:String(s.source_contact_id),message_id:String(s.message_id),record_id:String(s.record_id)});
  if(!tx.get('SELECT 1 FROM message WHERE owner_id=? AND contact_id=? AND id=? AND interpretation_revision=?',[ownerId,s.source_contact_id,s.message_id,s.accepted_revision]))fail('memory_source_stale');
 }
 return {attempt:a,basis};
}
function blocks(tx:StorageTransaction,ownerId:string,attemptId:string):readonly unknown[] {
 const event=tx.get(`SELECT e.payload FROM execution_event e JOIN model_call c ON c.owner_id=e.owner_id AND c.id=coalesce(e.originated_call_id,e.reused_call_id) JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id WHERE e.owner_id=? AND e.step_attempt_id=? AND e.kind='adjudication_output' AND c.state='succeeded' AND o.commit_forbidden_at IS NULL`,[ownerId,attemptId]);
 if(!event)fail('memory_adjudication_output_unbound');return JSON.parse(String(event!.payload)).blocks;
}
function evidenceSupported(item:AdjudicationItem,evidence:readonly {message_id:string;quote:string}[]):boolean {
 const source=[...item.candidate_source_texts,...item.similar.flatMap(p=>p.source_texts)];return evidence.length>0&&evidence.every(e=>e.quote.trim()&&source.some(s=>s.content_kind!=='image'&&s.message_id===e.message_id&&typeof s.text==='string'&&s.text.includes(e.quote)));
}
/** 关系核验证据须逐字有效并覆盖所声称关联的旧记忆；independent 关系只依赖候选自身来源，不要求引用无关旧记忆原文。 */
function relationCovered(item:AdjudicationItem,kind:string,ids:readonly string[],evidence:readonly {message_id:string;quote:string}[]):boolean {
 if(!evidenceSupported(item,evidence))return false;
 const cited=new Set(evidence.map(e=>e.message_id));
 if(!item.candidate.source_message_ids.some(id=>cited.has(id)))return false;
 if(kind==='independent')return true;
 const available=new Set([...item.candidate_source_texts,...item.similar.flatMap(m=>m.source_texts)].map(s=>s.message_id));
 return ids.every(id=>{const parent=item.similar.find(m=>m.memory_id===id);if(!parent)return false;const sources=parent.source_message_ids.filter(source=>available.has(source));return !sources.length||sources.some(source=>cited.has(source));});
}
function finish(tx:StorageTransaction,raw:unknown,lease:StorageLease) {
 const i=raw as {ownerId:string;attemptIds:string[]},ownerId=id(i.ownerId);if(!Array.isArray(i.attemptIds)||!i.attemptIds.length||i.attemptIds.length>10000)fail('memory_adjudication_stale');
 const stages=i.attemptIds.map(a=>({id:a,...current(tx,ownerId,id(a),lease)})),first=stages[0]!,basis=first.basis,item=basis.item;
 if(first.attempt.kind!=='adjudication'||stages.some(s=>digest({...s.basis,pageIndex:0})!==digest({...basis,pageIndex:0}))||new Set(stages.map(s=>`${s.attempt.kind}:${s.basis.pageIndex}`)).size!==stages.length)fail('memory_adjudication_stale');
 let action:'auto_accept'|'auto_update'|'auto_noop'='auto_accept',target:Basis['parents'][number]|undefined,text:string|undefined,formation:'adoption'|'change'|'correction'='adoption',parents:Basis['parents']=[],reason:string|null=null,skippedSources:{duplicateMemoryId:string;newSources:string[]}|undefined;
 const mediaRelationPending=requiresMultimodalRelationReview(item);
 if(mediaRelationPending)reason='memory_media_relation_pending';
 const pageCount=mediaRelationPending?0:Math.ceil(item.similar.length/8);
 if(stages.filter(s=>s.attempt.kind==='adjudication').length!==Math.max(1,pageCount)||stages.some(s=>s.basis.pageIndex<0||s.basis.pageIndex>=Math.max(1,pageCount)))fail('memory_adjudication_output_unbound');
 for(let pageIndex=0;pageIndex<pageCount;pageIndex++){
  const item={...basis.item,similar:basis.item.similar.slice(pageIndex*8,pageIndex*8+8)};
  const pageStage=stages.find(s=>s.attempt.kind==='adjudication'&&s.basis.pageIndex===pageIndex);if(!pageStage)fail('memory_adjudication_output_unbound');
  const decisions=parseAdjudications(blocks(tx,ownerId,pageStage!.id));if(decisions.length!==1||decisions[0]!.candidate_index!==0)fail('memory_adjudication_output_unbound');const decision=decisions[0]!;
  const stage=stages.find(s=>s.attempt.kind==='relation_verification'&&s.basis.pageIndex===pageIndex);if(!stage)fail('memory_adjudication_output_unbound');
  const checked=parseRelations(blocks(tx,ownerId,stage!.id),[item]);if(checked.length!==1||checked[0]!.candidate_index!==0)fail('memory_adjudication_output_unbound');const verification=checked[0]!,relation=decision.relation;
  const ids=relation?.related_memory_ids??[];
  // 原因码拆分：真矛盾、核验不支持、证据覆盖不足、模型自相矛盾分别计数，读取层与界面借此分别呈现。
  const relationEvidenceOK=!!relation&&evidenceSupported(item,relation.evidence),relationCoveredOK=!!relation&&relationCovered(item,decision.action==='noop'?'supplement':relation.kind,ids,verification.evidence);
  if(!relation||relation.kind==='unresolved_conflict'||!verification.supported||!relationEvidenceOK||!relationCoveredOK||!ids.length||new Set(ids).size!==ids.length||ids.some(p=>!item.similar.some(m=>m.memory_id===p))||relation.claim_changed!==verification.claim_changed||relation.condition_changed!==verification.condition_changed)
   reason=!relation||relation.kind==='unresolved_conflict'?'memory_relation_conflict':!verification.supported?'memory_relation_unsupported':!(relationEvidenceOK&&relationCoveredOK)?'memory_relation_evidence_incomplete':'memory_relation_inconsistent';
  else if(decision.action==='add'||decision.action==='keep'){
   // add 对齐腾讯 store 的「全新独立」；keep 对齐「相关并存」，由模型并核验确认与旧记忆互不改动时自动并存。
   const kindAllowed=decision.action==='add'?relation.kind==='independent':['independent','supplement','historical_supplement'].includes(relation.kind);
   if(!kindAllowed||relation.claim_changed||relation.condition_changed)reason='memory_relation_inconsistent';
  }else if(decision.action==='update'){
   if(target){reason='memory_multiple_targets_pending';continue;}
   target=basis.parents.find(p=>p.id===decision.replaced_memory_id&&item.similar.some(m=>m.memory_id===p.id));const prior=item.similar.find(p=>p.memory_id===target?.id);
   if(!target||ids.length!==1||ids[0]!==target.id||target.protected||prior?.adoption_method!=='auto')reason='memory_protected';
   else if(!['state_change','error_correction'].includes(relation.kind)||!relation.claim_changed||relation.condition_changed||!item.candidate.source_message_ids.some(s=>!prior.source_message_ids.includes(s)))reason='memory_relation_pending';
   else if(item.candidate.event||prior.event||item.candidate.conditions||prior.conditions||item.candidate.valid_at!==prior.valid_at||item.candidate.invalid_at!==prior.invalid_at)reason='memory_timeline_pending';
   else if(prior.statement_time&&item.candidate_source_texts.every(s=>s.occurred_at===null||s.occurred_at<prior.statement_time!))reason='memory_timeline_pending';
   else {action='auto_update';formation=relation.kind==='error_correction'?'correction':'change';parents=[target];}
  }else if(decision.action==='merge'){
   if(target){reason='memory_multiple_targets_pending';continue;}
   const mergedIds=decision.merged_memory_ids??[];parents=mergedIds.map(p=>basis.parents.find(m=>m.id===p)!).filter(Boolean);target=parents[0];
   const stage=stages.find(s=>s.attempt.kind==='merge_verification'&&s.basis.pageIndex===pageIndex);if(!stage)fail('memory_adjudication_output_unbound');const merge=mergeResult(readExtractionToolArguments(blocks(tx,ownerId,stage!.id),'MergedMemoryVerificationOutput').value);const mergeItem={...item,similar:item.similar.filter(p=>mergedIds.includes(p.memory_id))};const requiredMergeSources=new Set([...item.candidate.source_message_ids,...mergeItem.similar.flatMap(p=>p.source_message_ids)]),citedMergeSources=new Set(merge.evidence.map(e=>e.message_id));
   if(mergedIds.length<2||mergedIds.length>8||new Set(mergedIds).size!==mergedIds.length||parents.length!==mergedIds.length||mergedIds.some(p=>!ids.includes(p))||ids.some(p=>!mergedIds.includes(p))||parents.some(p=>p.protected||item.similar.find(m=>m.memory_id===p.id)?.adoption_method!=='auto'))reason='memory_protected';
   else if(relation.kind!=='supplement'||relation.claim_changed||relation.condition_changed||!merge.supported||merge.text!==decision.merged_text||!evidenceSupported(mergeItem,merge.evidence)||[...requiredMergeSources].some(source=>!citedMergeSources.has(source))||item.candidate.event||item.candidate.conditions||parents.some(p=>{const m=item.similar.find(m=>m.memory_id===p.id)!;return m.event||m.conditions||m.valid_at!==item.candidate.valid_at||m.invalid_at!==item.candidate.invalid_at;}))reason='memory_merge_pending';
   else {action='auto_update';text=merge.text;}
  }else if(decision.action==='noop'){
   const duplicate=basis.parents.find(p=>p.id===decision.duplicate_memory_id&&item.similar.some(m=>m.memory_id===p.id)),prior=item.similar.find(m=>m.memory_id===duplicate?.id);
   const fact=item.candidate;
   if(target||!duplicate||!prior||ids.length!==1||ids[0]!==duplicate.id||relation.claim_changed||relation.condition_changed)reason='memory_duplicate_pending';
   // 同义重复对齐腾讯 skip：模型判无增量且旧正文信息量不更少（长度代理）时自动跳过；noop 不改写记忆内容，
   // 受保护或已撤回的目标维持原状而候选被消费，因此不因保护状态拦截。现有来源模型不支持向旧版本追加引用，
   // 候选新增来源只记 skipped_duplicate 执行事件，不改旧记忆。
   else if([...prior.text].length>=[...fact.text].length){
    action='auto_noop';target=duplicate;parents=[duplicate];
    skippedSources={duplicateMemoryId:target.id,newSources:[...new Set(fact.source_message_ids)].filter(s=>!prior.source_message_ids.includes(s))};
   }
   else reason='memory_duplicate_pending';
  }else reason='memory_duplicate_pending';
 }
 for(const s of stages){
  if(tx.get("SELECT 1 FROM model_call WHERE owner_id=? AND step_attempt_id=? AND state<>'succeeded'",[ownerId,s.id]))fail('memory_adjudication_receipt_unknown');
  tx.run("UPDATE step_attempt SET state='succeeded',finished_at=? WHERE owner_id=? AND id=?",[Date.now(),ownerId,s.id]);tx.run("UPDATE processing_step SET state='succeeded',successful_attempt_id=? WHERE owner_id=? AND id=?",[s.id,ownerId,s.attempt.step_id]);
  tx.run("UPDATE model_operation SET state='applied' WHERE owner_id=? AND memory_step_id=? AND state='resolved'",[ownerId,s.attempt.step_id]);
  for(const table of ['operation_item','operation_scope'])tx.run(`UPDATE ${table} SET state='released' WHERE owner_id=? AND operation_id IN (SELECT id FROM model_operation WHERE owner_id=? AND memory_step_id=?)`,[ownerId,ownerId,s.attempt.step_id]);
 }
 let result=null;
 // 先记录真实裁决；采纳与完成仍在同一事务，任何CAS或来源失败会全部回滚。
 // 采纳留痕：未核实事件标注与自由文本不确定性都记入裁决结果事件，不新增持久字段。
 const notice:Record<string,unknown>={};
 if(!reason){if(basis.eventTimeUnverified)notice.time_unverified=true;const alternatives=item.candidate.alternatives;if(Array.isArray(alternatives)&&alternatives.length)notice.adopted_with_alternatives=[...alternatives];}
 record(tx,ownerId,first.id,'adjudication_result',{candidateId:basis.candidateId,reason,action:reason?'pending':action,parentMemoryIds:parents.map(p=>p.id),text:text??item.candidate.text,...notice});
 if(!reason&&skippedSources)record(tx,ownerId,first.id,'skipped_duplicate',{candidateId:basis.candidateId,...skippedSources});
 if(!reason){
  result=applyDecision(tx,{ownerId,request:{requestKey:`memory:adjudication:${String(first.attempt.step_id)}`,action,candidateIds:[basis.candidateId],candidateRevisions:[basis.candidateRevision],...(target?{memoryId:target.id,expectedVersionNo:target.versionNo,expectedHeadRevision:target.headRevision}:{})}},true,{executionId:first.id,body:text,formation,parents:parents.map(p=>({memoryId:p.id,versionNo:BigInt(p.versionNo)}))});
  if(parents.length>1)retireMergedParents(tx,{ownerId,executionId:first.id,primaryMemoryId:result.memoryId!,requestKey:`memory:adjudication:${String(first.attempt.step_id)}`,parents:parents.map(p=>({memoryId:p.id,versionNo:BigInt(p.versionNo),headRevision:BigInt(p.headRevision)}))});
 }

 return {result,reason};
}
export const memoryAdjudicationActions:StorageAction[]=[
 act('claim','write',(tx,raw,lease)=>{
  const i=raw as {ownerId:string;candidateId:string};id(i.ownerId);id(i.candidateId);
  const prior=tx.all(`SELECT s.state,e.payload FROM step_input i JOIN processing_step s ON s.owner_id=i.owner_id AND s.id=i.step_id JOIN step_attempt a ON a.owner_id=s.owner_id AND a.step_id=s.id JOIN execution_event e ON e.owner_id=a.owner_id AND e.step_attempt_id=a.id AND e.kind='adjudication_basis' WHERE i.owner_id=? AND i.candidate_id=? AND s.kind='adjudication' ORDER BY s.step_no DESC`,[i.ownerId,i.candidateId]);
  if(prior.some(p=>p.state==='running'||p.state==='unknown'))return null;
  try{const basis=freeze(tx,i.ownerId,i.candidateId);if(prior.length&&BigInt(basis.intentRevision)<=BigInt((JSON.parse(String(prior[0]!.payload)) as Basis).intentRevision))return null;
  // 已有完成裁决且依据（候选、同范围记忆版本、对比池）完全未变：控制修订推进（继续／放弃重试）不重复发送模型请求。
  if(prior.length&&decidedWithSameBasis(tx,i.ownerId,i.candidateId,basis))return null;
  // 同一任务的目标资料已被未知裁决调用占位：继续领取只会在建调用前撞唯一索引，改为明确停止。
  if(unknownOccupancy(tx,i.ownerId,basis.taskId))fail('memory_adjudication_receipt_unknown');
  return makeStep(tx,i.ownerId,basis,'adjudication',lease);} catch(error){if(error instanceof StorageFailure&&['memory_conditions_pending','memory_verification_pending','memory_withdrawn_scope_pending','memory_adjudication_pool_limit','memory_adjudication_paused',AMBIGUITY_UNCONFIRMED].includes(error.code)){try{if(error.code==='memory_conditions_pending'||error.code===AMBIGUITY_UNCONFIRMED)recordCandidateGate(tx,i.ownerId,id(i.candidateId),error.code);}catch{/* 留痕失败不改变原有门槛失败语义 */}return null;}throw error;}
 }),
 act('stage','write',(tx,raw,lease)=>{const i=raw as {ownerId:string;attemptId:string;purpose:SqliteAdjudicationModelPurpose;pageIndex:number};if(!purposes.includes(i.purpose)||!Number.isSafeInteger(i.pageIndex)||i.pageIndex<0)fail('memory_adjudication_purpose_invalid');const {basis}=current(tx,i.ownerId,i.attemptId,lease);if(i.pageIndex>=Math.max(1,Math.ceil(basis.item.similar.length/8)))fail('memory_adjudication_purpose_invalid');return makeStep(tx,i.ownerId,{...basis,pageIndex:i.pageIndex},i.purpose,lease);}),
 act('holders','read',(tx,raw,lease)=>{const i=raw as {ownerId:string;attemptId:string};const {attempt}=current(tx,i.ownerId,i.attemptId,lease);return tx.all("SELECT c.id AS contactId,c.data_generation AS generation FROM step_input i JOIN contact c ON c.owner_id=i.owner_id AND c.id=i.source_contact_id WHERE i.owner_id=? AND i.step_id=? AND i.kind='message' UNION SELECT c.id AS contactId,c.data_generation AS generation FROM task_contribution tc JOIN contact c ON c.owner_id=tc.owner_id AND c.id=tc.source_contact_id WHERE tc.owner_id=? AND tc.task_id=?",[i.ownerId,attempt.step_id,i.ownerId,attempt.task_id]).map(r=>({contactId:String(r.contactId),generation:String(r.generation)}));}),
 act('current','read',(tx,raw,lease)=>{const i=raw as {ownerId:string;attemptId:string};current(tx,id(i.ownerId),id(i.attemptId),lease);return true;}),
 act('prepareCall','write',(tx,raw,lease)=>{
  const i=raw as {ownerId:string;attemptId:string;purpose:SqliteAdjudicationModelPurpose;request:unknown;provider:string;model:string;configurationId:string;inputCap:number;outputCap:number};const {attempt,basis}=current(tx,i.ownerId,i.attemptId,lease);
  if(!purposes.includes(i.purpose)||attempt.kind!==i.purpose||!Number.isSafeInteger(i.inputCap)||i.inputCap<1||!Number.isSafeInteger(i.outputCap)||i.outputCap<1)fail('memory_adjudication_configuration_invalid');
  if(tx.get('SELECT 1 FROM model_operation WHERE owner_id=? AND memory_step_id=?',[i.ownerId,attempt.step_id]))fail('memory_adjudication_call_exists');
  const operationId=randomUUID(),callId=randomUUID(),requestId=randomUUID();
  tx.run("INSERT INTO model_operation(owner_id,id,purpose,memory_step_id,slot,input_seal,state) VALUES(?,?,?,?,0,?,'prepared')",[i.ownerId,operationId,i.purpose,attempt.step_id,digest(i.request)]);
  for(const item of tx.all("SELECT DISTINCT i.item_id FROM task_contribution t JOIN run_input i ON i.owner_id=t.owner_id AND i.run_id=t.run_id AND i.source_contact_id=t.source_contact_id WHERE t.owner_id=? AND t.task_id=? AND i.role='target'",[i.ownerId,basis.taskId]))tx.run("INSERT INTO operation_item VALUES(?,?,?,?,'reserved')",[i.ownerId,operationId,item.item_id,i.purpose]);
  for(const c of tx.all("SELECT DISTINCT source_contact_id FROM step_input WHERE owner_id=? AND step_id=? AND kind='message'",[i.ownerId,attempt.step_id]))tx.run("INSERT INTO operation_scope VALUES(?,?,?,?,'reserved')",[i.ownerId,operationId,c.source_contact_id,i.purpose]);
  tx.run("INSERT INTO model_call(owner_id,id,operation_id,attempt_no,step_attempt_id,provider,request_key,state,reserved_budget_units,settlement_state,model,configuration_id,input_cap,output_cap) VALUES(?,?,?,1,?,?,?,'prepared',0,'reserved',?,?,?,?)",[i.ownerId,callId,operationId,i.attemptId,id(i.provider),requestId,id(i.model),id(i.configurationId),i.inputCap,i.outputCap]);
  record(tx,i.ownerId,i.attemptId,'adjudication_input',i.request,callId,false,true);return {callId,requestId};
 }),
 act('reserve','write',(tx,raw,lease)=>{
  const {receipt:r,claim}=raw as {receipt:ModelLedgerReceipt;claim:ModelTaskClaim};validateModelLedgerReceipt(r);
  const c=tx.get('SELECT * FROM model_call WHERE owner_id=? AND id=? AND request_key=?',[r.owner_id,r.attempt_id,r.request_id]);if(!c?.step_attempt_id)fail('memory_adjudication_reservation_missing');const {attempt,basis}=current(tx,r.owner_id,String(c!.step_attempt_id),lease);
  const task=tx.get('SELECT resume_no FROM processing_task WHERE owner_id=? AND id=?',[r.owner_id,basis.taskId])!;
  if(!claim||claim.task_id!==basis.taskId||claim.step_id!==attempt.step_id||claim.step_name!==attempt.kind||claim.worker_id!==lease.runtimeId||BigInt(claim.lease_generation)!==task.resume_no||r.contact_id!==basis.contactId||r.provider!==c!.provider||r.model!==c!.model)fail('memory_adjudication_scope_invalid');
  const b=r.input_budget;if(!b||b.input_tokens>Number(c!.input_cap)||b.max_output_tokens!==Number(c!.output_cap)||c!.state!=='prepared')fail('memory_adjudication_budget_invalid');
  tx.run("UPDATE model_call SET state='sending',sent_at=?,reserved_budget_units=?,receipt=? WHERE owner_id=? AND id=?",[Date.now(),b!.input_tokens+b!.max_output_tokens,JSON.stringify(r),r.owner_id,c!.id]);tx.run("UPDATE model_operation SET state='in_flight' WHERE owner_id=? AND id=?",[r.owner_id,c!.operation_id]);for(const table of ['operation_item','operation_scope'])tx.run(`UPDATE ${table} SET state='sent' WHERE owner_id=? AND operation_id=?`,[r.owner_id,c!.operation_id]);return true;
 }),
 act('output','write',(tx,raw,lease)=>{const i=raw as {ownerId:string;attemptId:string;callId:string;blocks:readonly unknown[]};current(tx,i.ownerId,i.attemptId,lease);if(!tx.get("SELECT 1 FROM model_call WHERE owner_id=? AND id=? AND step_attempt_id=? AND state='succeeded'",[i.ownerId,i.callId,i.attemptId]))fail('memory_adjudication_output_unbound');const eventId=record(tx,i.ownerId,i.attemptId,'adjudication_output',{blocks:i.blocks},i.callId,false,true);for(const table of ['operation_item','operation_scope'])tx.run(`UPDATE ${table} SET state='released' WHERE owner_id=? AND operation_id=(SELECT operation_id FROM model_call WHERE owner_id=? AND id=?)`,[i.ownerId,i.ownerId,i.callId]);return eventId;}),
 act('finish','write',finish),
 act('fail','write',(tx,raw)=>{
  const i=raw as {ownerId:string;attemptIds:string[];code:string;providerFailure?:unknown},provider=failureProvider(i.providerFailure);for(const attemptId of i.attemptIds){const a=tx.get("SELECT step_id,state FROM step_attempt WHERE owner_id=? AND id=? AND state IN ('running','aborted')",[i.ownerId,attemptId]);if(!a)continue;
   if(a.state==='running'&&!tx.get("SELECT 1 FROM model_operation WHERE owner_id=? AND memory_step_id=? AND state='sealed'",[i.ownerId,a.step_id]))record(tx,i.ownerId,attemptId,'adjudication_failure',{code:id(i.code),...(provider?{provider_failure:provider}:{})});
   tx.run("UPDATE model_call SET state='unknown',settlement_state='unknown' WHERE owner_id=? AND step_attempt_id=? AND state='sending'",[i.ownerId,attemptId]);tx.run("UPDATE model_call SET state='failed',settlement_state='settled',error_code='not_dispatched' WHERE owner_id=? AND step_attempt_id=? AND state='prepared'",[i.ownerId,attemptId]);
   const unknown=!!tx.get("SELECT 1 FROM model_call WHERE owner_id=? AND step_attempt_id=? AND state='unknown'",[i.ownerId,attemptId]);
   for(const o of tx.all('SELECT operation_id,state FROM model_call WHERE owner_id=? AND step_attempt_id=?',[i.ownerId,attemptId])){tx.run("UPDATE model_operation SET state=? WHERE owner_id=? AND id=? AND state<>'sealed'",[o.state==='unknown'?'unknown':'failed',i.ownerId,o.operation_id]);for(const table of ['operation_item','operation_scope'])tx.run(`UPDATE ${table} SET state=? WHERE owner_id=? AND operation_id=?`,[o.state==='unknown'?'unknown':'released',i.ownerId,o.operation_id]);}
   if(a.state==='running'){tx.run('UPDATE step_attempt SET state=?,finished_at=?,error_code=? WHERE owner_id=? AND id=?',[unknown?'unknown':'failed',Date.now(),id(i.code),i.ownerId,attemptId]);tx.run("UPDATE processing_step SET state=? WHERE owner_id=? AND id=? AND state<>'revoked'",[unknown?'unknown':'failed',i.ownerId,a.step_id]);}
  }return true;
 }),
 act('interrupted','read',(tx,raw,lease)=>tx.all("SELECT a.id FROM step_attempt a JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id WHERE a.owner_id=? AND s.kind IN ('adjudication','relation_verification','merge_verification') AND a.state='running' AND a.runtime_token<>?",[id((raw as any).ownerId),lease.runtimeId]).map(a=>String(a.id))),
];
