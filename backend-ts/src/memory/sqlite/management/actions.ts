import {qualificationSources} from './dependencies.ts';
import {randomUUID} from 'node:crypto';
import {sha256} from '../../../platform/sha256.ts';
import {StorageFailure,type StorageAction,type StorageRow,type StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {verifiedExtractionOutput} from '../outputs.ts';
import {AMBIGUITY_NOTE} from '../../extraction/bounded.ts';
import {AMBIGUITY_UNCONFIRMED,unconfirmedAmbiguity} from '../../extraction/ambiguity-guard.ts';
import {available,body,fail,id,integer,requireCandidate,requireAutomaticCandidate,requireSources,requireVersion,scope} from './qualification.ts';
import {managementRead,managementHistory} from './read.ts';
import {prepareManagementTimeline} from './timeline.ts';
import type {MemoryDecisionResult,MemoryScope} from './contracts.ts';
import {scheduleMemoryChange} from '../documents/later-schedule.ts';
const seal=(v:unknown):string=>sha256(JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x));
function executionRun(tx:StorageTransaction,ownerId:string,attemptId:unknown):string|undefined{
 if(typeof attemptId!=='string')return;
 const task=tx.get('SELECT t.run_id FROM step_attempt a JOIN processing_step ps ON ps.owner_id=a.owner_id AND ps.id=a.step_id JOIN processing_task t ON t.owner_id=ps.owner_id AND t.id=ps.task_id WHERE a.owner_id=? AND a.id=?',[ownerId,attemptId]);
 return task?String(task.run_id):undefined;
}
function advance(tx:StorageTransaction,ownerId:string,s:MemoryScope,formalChanged=true,runIds:string[]=[]):void{
 if(s.scopeKind==='self')tx.run('UPDATE owner SET memory_revision=memory_revision+1 WHERE owner_id=?',[ownerId]);
 else tx.run('UPDATE contact SET memory_revision=memory_revision+1 WHERE owner_id=? AND id=?',[ownerId,s.contactId]);
 if(formalChanged){const at=Date.now();scheduleMemoryChange(tx,ownerId,s,at,runIds[0]);for(const runId of runIds.slice(1))scheduleMemoryChange(tx,ownerId,s,at,runId);}
}
/** 门槛失败时向候选的提取 attempt 留痕，读取层据此把「真待确认」从「未完成」里分开；同 attempt 同 kind 只记一次。 */
export function recordCandidateGate(tx:StorageTransaction,ownerId:string,candidateId:unknown,kind:string,detail:Record<string,unknown>={}):void{
 const candidate=tx.get('SELECT produced_attempt_id FROM memory_candidate WHERE owner_id=? AND id=?',[ownerId,String(candidateId)]);if(!candidate)return;
 const attemptId=String(candidate.produced_attempt_id);
 if(tx.get('SELECT 1 FROM execution_event WHERE owner_id=? AND step_attempt_id=? AND kind=?',[ownerId,attemptId,kind]))return;
 const n=tx.get('SELECT coalesce(max(event_no),0)+1 AS n FROM execution_event WHERE owner_id=? AND step_attempt_id=?',[ownerId,attemptId])!.n;
 tx.run('INSERT INTO execution_event(owner_id,id,step_attempt_id,event_no,kind,originated_call_id,reused_call_id,payload,created_at) VALUES(?,?,?,?,?,NULL,NULL,?,?)',[ownerId,randomUUID(),attemptId,n,kind,JSON.stringify({candidateId:String(candidateId),...detail}),Date.now()]);
}
function result(tx:StorageTransaction,ownerId:string,d:StorageRow):MemoryDecisionResult{
 const v=tx.get('SELECT memory_id,version_no FROM memory_version WHERE owner_id=? AND decision_id=?',[ownerId,d.id]);
 return {decisionId:String(d.id),memoryId:d.target_memory_id as string|null,versionNo:v?String(v.version_no):null,action:String(d.action)};
}
function evidence(tx:StorageTransaction,ownerId:string,parent:{candidateId?:string;memoryId?:string;versionNo?:bigint},rows:StorageRow[]):void{
 const seen=new Set<string>();
 for(const r of rows){
  const key=String(r.message_id);if(!seen.has(key)){seen.add(key);tx.run('INSERT INTO memory_required_message VALUES(?,?,?,?,?,?,?)',[ownerId,randomUUID(),parent.candidateId??null,parent.memoryId??null,parent.versionNo??null,r.source_contact_id,r.message_id]);}
  const values=[ownerId,randomUUID(),parent.candidateId??null,parent.memoryId??null,parent.versionNo??null,r.source_contact_id,r.message_id,r.record_id,r.accepted_revision,r.span_start,r.span_end,r.explanation??null];
  if(r.content_kind&&r.content_kind!=='text')tx.run('INSERT INTO memory_citation(owner_id,id,candidate_id,memory_id,version_no,source_contact_id,message_id,record_id,accepted_revision,span_start,span_end,explanation,content_kind,content_ref_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[...values,r.content_kind,r.content_ref_json]);
  else tx.run('INSERT INTO memory_citation(owner_id,id,candidate_id,memory_id,version_no,source_contact_id,message_id,record_id,accepted_revision,span_start,span_end,explanation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',values);
 }
}
function importOutput(tx:StorageTransaction,ownerId:string,eventId:string):string{
 const prior=tx.get('SELECT id FROM memory_candidate WHERE owner_id=? AND event_id=?',[ownerId,eventId]);if(prior)return String(prior.id);
 const out=verifiedExtractionOutput(tx,{ownerId,eventId});const s={scopeKind:out.scopeKind,contactId:out.contactId};available(tx,ownerId,s,true);
 const candidateId=randomUUID();tx.run("INSERT INTO memory_candidate VALUES(?,?,?,?,?,?,?,?,'pending',0)",[ownerId,candidateId,out.scopeKind,out.contactId,out.proposedBody,out.producedAttemptId,eventId,out.outputNo]);
 evidence(tx,ownerId,{candidateId},out.citations.map(r=>({source_contact_id:r.contactId,message_id:r.messageId,record_id:r.recordId,accepted_revision:r.interpretationRevision,span_start:r.spanStart,span_end:r.spanEnd,explanation:r.explanation,...(r.contentKind?{content_kind:r.contentKind,content_ref_json:JSON.stringify(r.contentRef)}:{})})));

 return candidateId;
}
export interface AutomaticDecisionAuthority {executionId:string;body?:string;formation?:'correction'|'change'|'adoption';parents?:{memoryId:string;versionNo:bigint}[]}
export interface MergedParent {memoryId:string;versionNo:bigint;headRevision:bigint}
/** 主合并版和每个被撤回父项各有真实决定，共用同一次裁决执行，不重复消费候选。 */
export function retireMergedParents(tx:StorageTransaction,input:{ownerId:string;executionId:string;primaryMemoryId:string;requestKey:string;parents:MergedParent[]}):MemoryDecisionResult[]{
 const {ownerId,executionId,primaryMemoryId,requestKey,parents}=input;
 if(parents.length<2||parents.length>8||new Set(parents.map(p=>p.memoryId)).size!==parents.length||!parents.some(p=>p.memoryId===primaryMemoryId))fail('memory_merge_pending');
 const primary=tx.get('SELECT * FROM memory WHERE owner_id=? AND id=?',[ownerId,primaryMemoryId])??fail('memory_head_conflict'),original=parents.find(p=>p.memoryId===primaryMemoryId)!;
 const main=primary&&tx.get(`SELECT d.* FROM memory_version v JOIN memory_decision d ON d.owner_id=v.owner_id AND d.id=v.decision_id WHERE v.owner_id=? AND v.memory_id=? AND v.version_no=? AND d.action='auto_update' AND d.actor_kind='system' AND d.execution_id=? AND d.request_key=? AND d.outcome='applied'`,[ownerId,primaryMemoryId,primary.current_version_no,executionId,requestKey]);
 if(!primary||!main||primary.state!=='active'||primary.current_version_no!==original.versionNo+1n||primary.head_revision!==original.headRevision+1n)fail('memory_head_conflict');
 const snapshots=parents.filter(p=>p.memoryId!==primaryMemoryId).map(parent=>{
  const memory=tx.get('SELECT * FROM memory WHERE owner_id=? AND id=?',[ownerId,parent.memoryId])??fail('memory_head_conflict');
  if(!memory||memory.state!=='active'||memory.current_version_no!==parent.versionNo||memory.head_revision!==parent.headRevision)fail('memory_head_conflict');
  if(memory.manual_protection===1n)fail('memory_protected');if(memory.scope_kind!==primary.scope_kind||memory.contact_id!==primary.contact_id)fail('memory_scope_mismatch');
  const version=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,parent.memoryId,parent.versionNo])??fail('memory_merge_pending');
  if(!version||version.adoption_mode!=='auto')fail('memory_merge_pending');requireVersion(tx,ownerId,memory,version);qualificationSources(tx,ownerId,{memoryId:parent.memoryId,versionNo:parent.versionNo});return {memory,parent};
 });
 return snapshots.map(({memory,parent})=>{
  const decisionId=randomUUID(),key=`memory:merge-retire:${seal([requestKey,parent.memoryId])}`;
  tx.run("INSERT INTO memory_decision(owner_id,id,request_key,request_seal,action,actor_kind,execution_id,target_memory_id,expected_version_no,expected_head_revision,created_at,outcome) VALUES(?,?,?,?,'auto_retire','system',?,?,?,?,?,'applied')",[ownerId,decisionId,key,seal({requestKey,executionId,memoryId:parent.memoryId,versionNo:String(parent.versionNo),headRevision:String(parent.headRevision)}),executionId,parent.memoryId,parent.versionNo,parent.headRevision,Date.now()]);
  tx.run("UPDATE memory SET state='withdrawn',head_revision=head_revision+1 WHERE owner_id=? AND id=?",[ownerId,parent.memoryId]);advance(tx,ownerId,{scopeKind:memory.scope_kind as 'self'|'contact',contactId:memory.contact_id as string|null},true,[executionRun(tx,ownerId,executionId)].filter((id):id is string=>id!==undefined));
  return {decisionId,memoryId:parent.memoryId,versionNo:null,action:'auto_retire'};
 });
}
interface RetiredParent {memory:StorageRow;version:StorageRow;retirement:StorageRow;sources:StorageRow[]}
function restorableMergedParents(tx:StorageTransaction,ownerId:string,primary:StorageRow,current:StorageRow,expected:unknown):RetiredParent[]{
 const main=tx.get("SELECT * FROM memory_decision WHERE owner_id=? AND id=? AND action='auto_update' AND actor_kind='system' AND outcome='applied'",[ownerId,current.decision_id]);
 const snapshots=expected===undefined?[]:expected;
 if(!Array.isArray(snapshots))return fail('memory_request_invalid');
 if(snapshots.length>7||snapshots.some(p=>!p||typeof p!=='object'||Object.keys(p).sort().join(',')!=='headRevision,memoryId,versionNo')||new Set(snapshots.map(p=>id(p.memoryId))).size!==snapshots.length)fail('memory_request_invalid');
 for(const p of snapshots){integer(p.versionNo);integer(p.headRevision);}
 const retirements=main?.execution_id?tx.all("SELECT * FROM memory_decision WHERE owner_id=? AND execution_id=? AND action='auto_retire' AND actor_kind='system' AND outcome='applied' ORDER BY target_memory_id",[ownerId,main.execution_id]):[];
 if(retirements.length!==snapshots.length||retirements.some(r=>!snapshots.some(p=>p.memoryId===r.target_memory_id)))fail('memory_head_conflict');
 return retirements.map(retirement=>{
  const memory=tx.get('SELECT * FROM memory WHERE owner_id=? AND id=?',[ownerId,retirement.target_memory_id])??fail('memory_head_conflict');
  const snapshot=snapshots.find(p=>p.memoryId===memory.id)!;
  if(!memory||memory.state!=='withdrawn'||memory.current_version_no!==retirement.expected_version_no||memory.current_version_no!==integer(snapshot.versionNo)||memory.head_revision!==integer(snapshot.headRevision))fail('memory_head_conflict');
  if(memory.manual_protection===1n)fail('memory_protected');if(memory.scope_kind!==primary.scope_kind||memory.contact_id!==primary.contact_id)fail('memory_scope_mismatch');
  available(tx,ownerId,{scopeKind:memory.scope_kind as 'self'|'contact',contactId:memory.contact_id as string|null},true);
  const version=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,memory.id,memory.current_version_no])??fail('memory_restore_not_eligible');
  requireVersion(tx,ownerId,memory,version);qualificationSources(tx,ownerId,{memoryId:String(memory.id),versionNo:version.version_no as bigint});
  return {memory,version,retirement,sources:requireSources(tx,ownerId,{memoryId:String(memory.id),versionNo:version.version_no as bigint},version.adoption_mode==='manual')};
 });
}
function restoreMergedParents(tx:StorageTransaction,ownerId:string,requestKey:string,parents:RetiredParent[]):void{
 for(const {memory,version,retirement,sources} of parents){
  const decisionId=randomUUID(),versionNo=(version.version_no as bigint)+1n,key=`memory:merge-restore:${seal([requestKey,memory.id])}`;
  tx.run("INSERT INTO memory_decision(owner_id,id,request_key,request_seal,action,actor_kind,target_memory_id,expected_version_no,expected_head_revision,restored_from_version_no,created_at,outcome) VALUES(?,?,?,?,'restore','user',?,?,?,?,?,'applied')",[ownerId,decisionId,key,seal({requestKey,retirementId:retirement.id}),memory.id,version.version_no,memory.head_revision,version.version_no,Date.now()]);
  tx.run("INSERT INTO memory_version VALUES(?,?,?,?,'restore',?,?,?,?,0,'present','eligible')",[ownerId,memory.id,versionNo,version.body,version.adoption_mode,decisionId,version.version_no,version.version_no]);
  evidence(tx,ownerId,{memoryId:String(memory.id),versionNo},sources);
  tx.run("UPDATE memory SET current_version_no=?,state='active',head_revision=head_revision+1 WHERE owner_id=? AND id=?",[versionNo,ownerId,memory.id]);advance(tx,ownerId,{scopeKind:memory.scope_kind as 'self'|'contact',contactId:memory.contact_id as string|null});
 }
}
export function applyDecision(tx:StorageTransaction,input:unknown,system=false,authority?:AutomaticDecisionAuthority):MemoryDecisionResult{
 const q=input as any,ownerId=id(q?.ownerId),request=q?.request??{},requestKey=id(request.requestKey),fingerprint=seal(request);
 if(tx.get('SELECT 1 FROM request_tombstone WHERE owner_identity=? AND request_namespace=? AND request_key=?',[ownerId,'memory.applyDecision',requestKey]))fail('memory_decision_deleted');
 const old=tx.get('SELECT * FROM memory_decision WHERE owner_id=? AND request_key=?',[ownerId,requestKey]);
 if(old){
  if(old.outcome!=='applied')fail('memory_decision_deleted');if(old.request_seal!==fingerprint)fail('memory_request_conflict');
  const m=old.target_memory_id?tx.get('SELECT * FROM memory WHERE owner_id=? AND id=?',[ownerId,old.target_memory_id]):null;
  const v=old.action==='auto_noop'?tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,old.target_memory_id,old.expected_version_no]):tx.get('SELECT * FROM memory_version WHERE owner_id=? AND decision_id=?',[ownerId,old.id]);if(m&&v)requireVersion(tx,ownerId,m,v);
  if(old.action==='auto_noop'){if(!m||!v)fail('memory_source_stale');qualificationSources(tx,ownerId,{memoryId:String(old.target_memory_id),versionNo:old.expected_version_no as bigint});}
  return result(tx,ownerId,old);
 }
 const action=request.action as string;
 if(action!=='restore'&&request.expectedMergedParents!==undefined)fail('memory_request_invalid');
 if(!(system?['auto_accept','auto_update','auto_noop']:['accept','edit_accept','reject','correct','change','restore','withdraw','protect','unprotect','manual']).includes(action))fail('memory_request_invalid');
 const candidateIds=request.candidateIds??[],revisions=request.candidateRevisions??[];
 if(!Array.isArray(candidateIds)||!Array.isArray(revisions)||candidateIds.length>100||candidateIds.length!==revisions.length||new Set(candidateIds).size!==candidateIds.length)fail('memory_request_invalid');
 const needsCandidate=['accept','edit_accept','reject','auto_accept','auto_update','auto_noop'].includes(action);
 if(needsCandidate!==!!candidateIds.length)fail('memory_request_invalid');
 const candidates:StorageRow[]=candidateIds.map((value:unknown,index:number)=>{
  const c=tx.get('SELECT * FROM memory_candidate WHERE owner_id=? AND id=?',[ownerId,id(value)]);
  if(!c||c.state_revision!==integer(revisions[index]))return fail('memory_candidate_stale');requireCandidate(tx,ownerId,c);if(system)requireAutomaticCandidate(tx,ownerId,c);return c;
 });
 let m:StorageRow|undefined,previous:StorageRow|undefined;
 if(request.memoryId){
  m=tx.get('SELECT * FROM memory WHERE owner_id=? AND id=?',[ownerId,id(request.memoryId)]);if(m?.state==='invalidated')return fail('memory_source_stale');if(!m||(m.state!=='active'&&!(m.state==='withdrawn'&&['protect','unprotect','auto_noop'].includes(action))))return fail('memory_head_conflict');
  if(m.current_version_no!==integer(request.expectedVersionNo)||m.head_revision!==integer(request.expectedHeadRevision))fail('memory_head_conflict');
  previous=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,m.id,m.current_version_no]);if(!previous)return fail('memory_head_conflict');requireVersion(tx,ownerId,m,previous);
 }else if(['auto_update','auto_noop','correct','change','restore','withdraw','protect','unprotect'].includes(action))fail('memory_request_invalid');
 const s:MemoryScope=m?{scopeKind:m.scope_kind as 'self'|'contact',contactId:m.contact_id as string|null}:candidates[0]?{scopeKind:candidates[0].scope_kind as 'self'|'contact',contactId:candidates[0].contact_id as string|null}:scope(request.scope);
 available(tx,ownerId,s,true);
 if(system&&candidates.length!==1)fail('memory_relationship_pending');
 if(system&&['auto_update','auto_noop'].includes(action)&&!authority)fail('memory_relationship_pending');
 if(action==='auto_accept'&&!authority&&tx.get('SELECT 1 FROM memory WHERE owner_id=? AND scope_kind=? AND contact_id IS ?',[ownerId,s.scopeKind,s.contactId]))fail('memory_relationship_pending');
 if(system){
  const fact=verifiedExtractionOutput(tx,{ownerId,eventId:String(candidates[0]!.event_id)}).fact;
  // 与裁决前置门槛同一口径：整组未决指代、过期事实、条件无来源支持整体拦截；
  // 自由文本 alternatives 降级放行，未核实的事件标注按现行规格丢弃并留痕，都不再变成待确认。
  const eventTimeUnverified=!!fact.event&&(!fact.event.stage_verified||!fact.event.occurrence_verified&&fact.event.occurrence_start!==null);
  if(Array.isArray(fact.alternatives)&&fact.alternatives.length&&fact.alternatives.every((entry:unknown)=>entry===AMBIGUITY_NOTE)||fact.invalid_at&&Date.parse(fact.invalid_at)<=Date.now()||fact.conditions?.items.some((item:any)=>item.source_supported!==true))fail('memory_conditions_pending');
  // 代码层兜底：只拦自动路径（system 且无裁决授权）——正文含未标注的易歧义结构且 alternatives 为空时降级待确认；
  // 用户手动决定（memory.applyDecision，system=false）不经过这里，仍可按原逻辑采纳或修改；不改动已有原因码的含义。
  const ambiguity=system&&!authority?unconfirmedAmbiguity({text:String(fact.text??''),interpretationReason:fact.interpretation_reason,alternatives:fact.alternatives}):null;
  if(ambiguity){recordCandidateGate(tx,ownerId,candidates[0]!.id,AMBIGUITY_UNCONFIRMED,{rule:ambiguity.rule,token:ambiguity.token});fail(AMBIGUITY_UNCONFIRMED);}
  if(!authority){
   const attemptId=String(candidates[0]!.produced_attempt_id);
   const trace=(kind:string,payload:Record<string,unknown>)=>{
    const attempt=tx.get('SELECT step_id FROM step_attempt WHERE owner_id=? AND id=?',[ownerId,attemptId]);if(!attempt)return;
    const n=tx.get('SELECT coalesce(max(event_no),0)+1 AS n FROM execution_event WHERE owner_id=? AND step_attempt_id=?',[ownerId,attemptId])!.n;
    tx.run('INSERT INTO execution_event(owner_id,id,step_attempt_id,event_no,kind,originated_call_id,reused_call_id,payload,created_at) VALUES(?,?,?,?,?,NULL,NULL,?,?)',[ownerId,randomUUID(),attemptId,n,kind,JSON.stringify(payload),Date.now()]);
   };
   if(eventTimeUnverified)trace('time_unverified',{candidateId:candidates[0]!.id});
   if(Array.isArray(fact.alternatives)&&fact.alternatives.length)trace('adopted_with_alternatives',{candidateId:candidates[0]!.id,alternatives:[...fact.alternatives]});
  }
 }
 if(candidates.some(c=>c.scope_kind!==s.scopeKind||c.contact_id!==s.contactId))fail('memory_scope_mismatch');
 if(action==='auto_noop'){
  // 同一入口闭合实际调用、候选和唯一目标；删除重复触发器后也不能以缺项事件代签。
  const execution=tx.get(`SELECT 1 FROM step_attempt a JOIN processing_step ps ON ps.owner_id=a.owner_id AND ps.id=a.step_id
   JOIN processing_task t ON t.owner_id=ps.owner_id AND t.id=ps.task_id
   JOIN model_operation o ON o.owner_id=ps.owner_id AND o.memory_step_id=ps.id AND o.purpose='adjudication'
   JOIN model_call mc ON mc.owner_id=o.owner_id AND mc.operation_id=o.id AND mc.state='succeeded'
   JOIN step_input ci ON ci.owner_id=ps.owner_id AND ci.step_id=ps.id AND ci.kind='candidate'
   JOIN step_input mi ON mi.owner_id=ps.owner_id AND mi.step_id=ps.id AND mi.kind='memory'
   JOIN execution_event e ON e.owner_id=a.owner_id AND e.step_attempt_id=a.id AND e.kind='adjudication_result'
   JOIN execution_input cx ON cx.owner_id=e.owner_id AND cx.event_id=e.id AND cx.role='candidate' AND cx.planned_step_id=ci.step_id AND cx.planned_input_no=ci.input_no
   JOIN execution_input x ON x.owner_id=e.owner_id AND x.event_id=e.id AND x.role='parent_memory' AND x.planned_step_id=mi.step_id AND x.planned_input_no=mi.input_no
   WHERE a.owner_id=? AND a.id=? AND a.state='succeeded' AND ps.kind='adjudication' AND ps.state='succeeded' AND ps.successful_attempt_id=a.id
   AND t.state IN ('succeeded','awaiting_decision') AND t.scope_kind=? AND t.contact_id IS ?
   AND ci.candidate_id=? AND ci.accepted_state_revision=? AND mi.memory_id=? AND mi.memory_version_no=? AND mi.accepted_head_revision=?
   AND json_extract(e.payload,'$.action')='auto_noop' AND json_extract(e.payload,'$.candidateId')=? AND json_type(e.payload,'$.reason')='null'
   AND json_type(e.payload,'$.parentMemoryIds')='array' AND json_array_length(e.payload,'$.parentMemoryIds')=1 AND json_extract(e.payload,'$.parentMemoryIds[0]')=mi.memory_id
   AND (SELECT count(*) FROM execution_event result WHERE result.owner_id=a.owner_id AND result.step_attempt_id=a.id AND result.kind='adjudication_result')=1`,[ownerId,authority!.executionId,s.scopeKind,s.contactId,candidates[0]!.id,candidates[0]!.state_revision,m!.id,previous!.version_no,m!.head_revision,candidates[0]!.id]);
  if(!execution)fail('memory_adjudication_output_unbound');
  qualificationSources(tx,ownerId,{candidateId:String(candidates[0]!.id)});qualificationSources(tx,ownerId,{memoryId:String(m!.id),versionNo:previous!.version_no as bigint});
 }

 if(m&&['auto_update','restore','withdraw'].includes(action)&&m.manual_protection===1n)fail('memory_protected');
 if((action==='auto_accept'||action==='accept'||action==='manual')&&m)fail('memory_request_invalid');
 if(action==='reject'&&m)fail('memory_request_invalid');
 if(action==='withdraw'&&(previous!.adoption_mode!=='auto'||previous!.previous_version_no!==null))fail('memory_restore_not_eligible');
 let restored:StorageRow|undefined,retiredParents:RetiredParent[]=[];
 if(action==='restore'){
  if(previous!.adoption_mode!=='auto'||previous!.formation_kind==='restore'||previous!.previous_version_no===null||integer(request.restoredFromVersionNo)!==previous!.previous_version_no)fail('memory_restore_not_eligible');
  restored=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,m!.id,previous!.previous_version_no]);if(!restored)return fail('memory_restore_not_eligible');requireVersion(tx,ownerId,m!,restored);retiredParents=restorableMergedParents(tx,ownerId,m!,previous!,request.expectedMergedParents);
 }
 const noVersion=['reject','withdraw','protect','unprotect','auto_noop'].includes(action),memoryId=m?String(m.id):action==='reject'?null:randomUUID(),decisionId=randomUUID();
 if(!m&&memoryId)tx.run("INSERT INTO memory(owner_id,id,scope_kind,contact_id,current_version_no,head_revision,state,manual_protection,protection_decision_id) VALUES(?,?,?,?,NULL,0,'invalidated',0,NULL)",[ownerId,memoryId,s.scopeKind,s.contactId]);
 tx.run('INSERT INTO memory_decision VALUES(?,?,?,?,?,?,?,?,?,?,?,?,\'applied\')',[ownerId,decisionId,requestKey,fingerprint,action,system?'system':'user',system?authority?.executionId??candidates[0]!.produced_attempt_id:null,memoryId,previous?.version_no??null,m?.head_revision??null,restored?.version_no??null,Date.now()]);
 // 重复跳过由决定触发器原子消费，避免留下无候选的无版本决定。
 for(const c of action==='auto_noop'?[]:candidates){
  tx.run('INSERT INTO decision_candidate VALUES(?,?,?,?,?)',[ownerId,decisionId,c.id,action==='reject'?'rejected':'accepted',c.state_revision]);
  tx.run('UPDATE memory_candidate SET state=?,state_revision=state_revision+1 WHERE owner_id=? AND id=?',[action==='reject'?'rejected':'adopted',ownerId,c.id]);
 }
 if(noVersion){
  if(m&&action==='withdraw')tx.run("UPDATE memory SET state='withdrawn',head_revision=head_revision+1 WHERE owner_id=? AND id=?",[ownerId,memoryId]);
  else if(m&&action!=='auto_noop')tx.run('UPDATE memory SET manual_protection=?,protection_decision_id=?,head_revision=head_revision+1 WHERE owner_id=? AND id=?',[action==='protect'?1:0,decisionId,ownerId,memoryId]);
 }else{
  const versionNo=previous?(previous.version_no as bigint)+1n:1n;
  const text=authority?.body?body(authority.body):restored?String(restored.body):['edit_accept','correct','change','manual'].includes(action)?body(request.body):candidates.map(c=>String(c.proposed_body)).join('\n');
  const mode=restored?String(restored.adoption_mode):system?'auto':action==='manual'||previous?.adoption_mode==='manual'&&!candidates.length?'manual':'user';
  const formation=authority?.formation??(restored?'restore':action==='correct'?'correction':action==='change'?'change':action==='manual'?'manual':'adoption');
  tx.run("INSERT INTO memory_version VALUES(?,?,?,?,?,?,?,?,?,?,'present','eligible')",[ownerId,memoryId,versionNo,text,formation,mode,decisionId,previous?.version_no??null,restored?.version_no??null,m?.manual_protection??0n]);
  const sources:StorageRow[]=[];
  if(restored)sources.push(...requireSources(tx,ownerId,{memoryId:memoryId!,versionNo:restored.version_no as bigint},restored.adoption_mode==='manual'));
  else{
   if(previous)sources.push(...requireSources(tx,ownerId,{memoryId:memoryId!,versionNo:previous.version_no as bigint},previous.adoption_mode==='manual'));
   for(const parent of authority?.parents??[])sources.push(...requireSources(tx,ownerId,{memoryId:parent.memoryId,versionNo:parent.versionNo}));
   for(const c of candidates)sources.push(...requireSources(tx,ownerId,{candidateId:String(c.id)}));
  }
  const distinct=new Map(sources.map(r=>[JSON.stringify([r.source_contact_id,r.record_id,r.span_start?.toString(),r.span_end?.toString()]),r]));
  evidence(tx,ownerId,{memoryId:memoryId!,versionNo},[...distinct.values()]);
  tx.run("UPDATE memory SET current_version_no=?,head_revision=head_revision+1,state='active' WHERE owner_id=? AND id=?",[versionNo,ownerId,memoryId]);
 }
 if(action==='restore')restoreMergedParents(tx,ownerId,requestKey,retiredParents);
 const runIds=[...new Set([authority?.executionId,...candidates.map(c=>c.produced_attempt_id)].flatMap(attempt=>{const runId=executionRun(tx,ownerId,attempt);return runId?[runId]:[];}))];
 advance(tx,ownerId,s,!noVersion||action==='withdraw',runIds);return result(tx,ownerId,tx.get('SELECT * FROM memory_decision WHERE owner_id=? AND id=?',[ownerId,decisionId])!);
}
function importRun(tx:StorageTransaction,input:unknown):{candidateIds:string[]}{
 const q=input as any,ownerId=id(q?.ownerId),runId=id(q?.runId),ids:string[]=[];
 if(!tx.get('SELECT 1 FROM processing_run WHERE owner_id=? AND id=?',[ownerId,runId]))fail('memory_run_not_found');
 for(const e of tx.all(`SELECT e.id FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE e.owner_id=? AND t.run_id=? AND e.kind='verified_output' ORDER BY e.id`,[ownerId,runId])){
  try{ids.push(importOutput(tx,ownerId,String(e.id)));}
  catch(error){if(!(error instanceof StorageFailure)||!['memory_extraction_scope_stale','memory_extraction_source_stale','memory_extraction_output_not_eligible','history_source_not_available'].includes(error.code))throw error;}
 }
 return {candidateIds:ids};
}
export const memoryManagementActions:StorageAction[]=[
 {name:'memory.importRun',mode:'write',retryBusy:true,execute:importRun},
 {name:'memory.publishRun',mode:'write',retryBusy:true,execute(tx,input){
  const ownerId=id((input as any)?.ownerId),imported=importRun(tx,input),results:MemoryDecisionResult[]=[];
  for(const candidateId of imported.candidateIds){
   const c=tx.get("SELECT * FROM memory_candidate WHERE owner_id=? AND id=? AND state='pending'",[ownerId,candidateId]);if(!c)continue;
   try{results.push(applyDecision(tx,{ownerId,request:{requestKey:`memory:auto:${String(c.event_id)}`,action:'auto_accept',candidateIds:[candidateId],candidateRevisions:[String(c.state_revision)]}},true));}
   catch(error){if(!(error instanceof StorageFailure)||!['memory_relationship_pending','memory_conditions_pending','memory_verification_pending',AMBIGUITY_UNCONFIRMED].includes(error.code))throw error;}
  }
  return {candidateIds:imported.candidateIds,decisions:results};
 }},
 {name:'memory.applyDecision',mode:'write',retryBusy:true,execute:(tx,input)=>applyDecision(tx,input)},
 {name:'memory.applyAutomaticDecision',mode:'write',retryBusy:true,execute:(tx,input)=>applyDecision(tx,input,true)},
 {name:'memory.read',mode:'read',retryBusy:false,execute:managementRead},
 {name:'memory.prepareTimeline',mode:'write',retryBusy:true,execute:prepareManagementTimeline},
 {name:'memory.history',mode:'read',retryBusy:false,execute:managementHistory},
];
