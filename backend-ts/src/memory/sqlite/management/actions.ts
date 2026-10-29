import {randomUUID,createHash} from 'node:crypto';
import {StorageFailure,type StorageAction,type StorageRow,type StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {verifiedExtractionOutput} from '../outputs.ts';
import {available,body,fail,id,integer,requireCandidate,requireSources,requireVersion,scope} from './qualification.ts';
import {managementRead} from './read.ts';
import type {MemoryDecisionResult,MemoryScope} from './contracts.ts';
const seal=(v:unknown):string=>createHash('sha256').update(JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x)).digest('hex');
function advance(tx:StorageTransaction,ownerId:string,s:MemoryScope):void{
 if(s.scopeKind==='self')tx.run('UPDATE owner SET memory_revision=memory_revision+1 WHERE owner_id=?',[ownerId]);
 else tx.run('UPDATE contact SET memory_revision=memory_revision+1 WHERE owner_id=? AND id=?',[ownerId,s.contactId]);
}
function result(tx:StorageTransaction,ownerId:string,d:StorageRow):MemoryDecisionResult{
 const v=tx.get('SELECT memory_id,version_no FROM memory_version WHERE owner_id=? AND decision_id=?',[ownerId,d.id]);
 return {decisionId:String(d.id),memoryId:d.target_memory_id as string|null,versionNo:v?String(v.version_no):null,action:String(d.action)};
}
function evidence(tx:StorageTransaction,ownerId:string,parent:{candidateId?:string;memoryId?:string;versionNo?:bigint},rows:StorageRow[]):void{
 const seen=new Set<string>();
 for(const r of rows){
  const key=String(r.message_id);if(!seen.has(key)){seen.add(key);tx.run('INSERT INTO memory_required_message VALUES(?,?,?,?,?,?,?)',[ownerId,randomUUID(),parent.candidateId??null,parent.memoryId??null,parent.versionNo??null,r.source_contact_id,r.message_id]);}
  tx.run('INSERT INTO memory_citation VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[ownerId,randomUUID(),parent.candidateId??null,parent.memoryId??null,parent.versionNo??null,r.source_contact_id,r.message_id,r.record_id,r.accepted_revision,r.span_start,r.span_end,r.explanation??null]);
 }
}
function importOutput(tx:StorageTransaction,ownerId:string,eventId:string):string{
 const prior=tx.get('SELECT id FROM memory_candidate WHERE owner_id=? AND event_id=?',[ownerId,eventId]);if(prior)return String(prior.id);
 const out=verifiedExtractionOutput(tx,{ownerId,eventId});const s={scopeKind:out.scopeKind,contactId:out.contactId};available(tx,ownerId,s,true);
 const candidateId=randomUUID();tx.run("INSERT INTO memory_candidate VALUES(?,?,?,?,?,?,?,?,'pending',0)",[ownerId,candidateId,out.scopeKind,out.contactId,out.proposedBody,out.producedAttemptId,eventId,out.outputNo]);
 const unique=new Map(out.sources.map(r=>[r.recordId,r]));
 evidence(tx,ownerId,{candidateId},[...unique.values()].map(r=>{
  const m=tx.get('SELECT text_body FROM message WHERE owner_id=? AND contact_id=? AND id=?',[ownerId,r.contactId,r.messageId]);
  return {source_contact_id:r.contactId,message_id:r.messageId,record_id:r.recordId,accepted_revision:r.interpretationRevision,span_start:0n,span_end:BigInt([...String(m?.text_body??'')].length),explanation:null};
 }));return candidateId;
}
export function applyDecision(tx:StorageTransaction,input:unknown,system=false):MemoryDecisionResult{
 const q=input as any,ownerId=id(q?.ownerId),request=q?.request??{},requestKey=id(request.requestKey),fingerprint=seal(request);
 if(tx.get('SELECT 1 FROM request_tombstone WHERE owner_identity=? AND request_namespace=? AND request_key=?',[ownerId,'memory.applyDecision',requestKey]))fail('memory_decision_deleted');
 const old=tx.get('SELECT * FROM memory_decision WHERE owner_id=? AND request_key=?',[ownerId,requestKey]);
 if(old){
  if(old.outcome!=='applied')fail('memory_decision_deleted');if(old.request_seal!==fingerprint)fail('memory_request_conflict');
  const m=old.target_memory_id?tx.get('SELECT * FROM memory WHERE owner_id=? AND id=?',[ownerId,old.target_memory_id]):null;
  const v=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND decision_id=?',[ownerId,old.id]);if(m&&v)requireVersion(tx,ownerId,m,v);
  return result(tx,ownerId,old);
 }
 const action=request.action as string;
 if(!(system?['auto_accept','auto_update']:['accept','edit_accept','reject','correct','change','restore','withdraw','protect','unprotect','manual']).includes(action))fail('memory_request_invalid');
 const candidateIds=request.candidateIds??[],revisions=request.candidateRevisions??[];
 if(!Array.isArray(candidateIds)||!Array.isArray(revisions)||candidateIds.length>100||candidateIds.length!==revisions.length||new Set(candidateIds).size!==candidateIds.length)fail('memory_request_invalid');
 const needsCandidate=['accept','edit_accept','reject','auto_accept','auto_update'].includes(action);
 if(needsCandidate!==!!candidateIds.length)fail('memory_request_invalid');
 const candidates:StorageRow[]=candidateIds.map((value:unknown,index:number)=>{
  const c=tx.get('SELECT * FROM memory_candidate WHERE owner_id=? AND id=?',[ownerId,id(value)]);
  if(!c||c.state_revision!==integer(revisions[index]))return fail('memory_candidate_stale');requireCandidate(tx,ownerId,c);return c;
 });
 let m:StorageRow|undefined,previous:StorageRow|undefined;
 if(request.memoryId){
  m=tx.get('SELECT * FROM memory WHERE owner_id=? AND id=?',[ownerId,id(request.memoryId)]);if(m?.state==='invalidated')return fail('memory_source_stale');if(!m||m.state!=='active')return fail('memory_head_conflict');
  if(m.current_version_no!==integer(request.expectedVersionNo)||m.head_revision!==integer(request.expectedHeadRevision))fail('memory_head_conflict');
  previous=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,m.id,m.current_version_no]);if(!previous)return fail('memory_head_conflict');requireVersion(tx,ownerId,m,previous);
 }else if(['auto_update','correct','change','restore','withdraw','protect','unprotect'].includes(action))fail('memory_request_invalid');
 const s:MemoryScope=m?{scopeKind:m.scope_kind as 'self'|'contact',contactId:m.contact_id as string|null}:candidates[0]?{scopeKind:candidates[0].scope_kind as 'self'|'contact',contactId:candidates[0].contact_id as string|null}:scope(request.scope);
 available(tx,ownerId,s,true);
 if(system&&candidates.length!==1)fail('memory_relationship_pending');
 if(action==='auto_accept'&&tx.get('SELECT 1 FROM memory WHERE owner_id=? AND scope_kind=? AND contact_id IS ?',[ownerId,s.scopeKind,s.contactId]))fail('memory_relationship_pending');
 if(system){
  const fact=verifiedExtractionOutput(tx,{ownerId,eventId:String(candidates[0]!.event_id)}).fact;
  if(Array.isArray(fact.alternatives)&&fact.alternatives.length||fact.invalid_at&&Date.parse(fact.invalid_at)<=Date.now()||fact.conditions?.items.some((item:any)=>item.source_supported!==true)||fact.event&&(!fact.event.stage_verified||!fact.event.occurrence_verified&&fact.event.occurrence_start!==null))fail('memory_conditions_pending');
 }
 if(candidates.some(c=>c.scope_kind!==s.scopeKind||c.contact_id!==s.contactId))fail('memory_scope_mismatch');
 if(m&&['auto_update','restore','withdraw'].includes(action)&&m.manual_protection===1n)fail('memory_protected');
 if((action==='auto_accept'||action==='accept'||action==='manual')&&m)fail('memory_request_invalid');
 if(action==='reject'&&m)fail('memory_request_invalid');
 if(action==='withdraw'&&(previous!.adoption_mode!=='auto'||previous!.previous_version_no!==null))fail('memory_restore_not_eligible');
 let restored:StorageRow|undefined;
 if(action==='restore'){
  if(previous!.adoption_mode!=='auto'||previous!.formation_kind==='restore'||previous!.previous_version_no===null||integer(request.restoredFromVersionNo)!==previous!.previous_version_no)fail('memory_restore_not_eligible');
  restored=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,m!.id,previous!.previous_version_no]);if(!restored)return fail('memory_restore_not_eligible');requireVersion(tx,ownerId,m!,restored);
 }
 const noVersion=['reject','withdraw','protect','unprotect'].includes(action),memoryId=m?String(m.id):action==='reject'?null:randomUUID(),decisionId=randomUUID();
 if(!m&&memoryId)tx.run("INSERT INTO memory VALUES(?,?,?,?,NULL,0,'invalidated',0,NULL)",[ownerId,memoryId,s.scopeKind,s.contactId]);
 tx.run('INSERT INTO memory_decision VALUES(?,?,?,?,?,?,?,?,?,?,?,?,\'applied\')',[ownerId,decisionId,requestKey,fingerprint,action,system?'system':'user',system?candidates[0]!.produced_attempt_id:null,memoryId,previous?.version_no??null,m?.head_revision??null,restored?.version_no??null,Date.now()]);
 for(const c of candidates){
  tx.run('INSERT INTO decision_candidate VALUES(?,?,?,?,?)',[ownerId,decisionId,c.id,action==='reject'?'rejected':'accepted',c.state_revision]);
  tx.run('UPDATE memory_candidate SET state=?,state_revision=state_revision+1 WHERE owner_id=? AND id=?',[action==='reject'?'rejected':'adopted',ownerId,c.id]);
 }
 if(noVersion){
  if(m&&action==='withdraw')tx.run("UPDATE memory SET state='withdrawn',head_revision=head_revision+1 WHERE owner_id=? AND id=?",[ownerId,memoryId]);
  else if(m)tx.run('UPDATE memory SET manual_protection=?,protection_decision_id=?,head_revision=head_revision+1 WHERE owner_id=? AND id=?',[action==='protect'?1:0,decisionId,ownerId,memoryId]);
 }else{
  const versionNo=previous?(previous.version_no as bigint)+1n:1n;
  const text=restored?String(restored.body):['edit_accept','correct','change','manual'].includes(action)?body(request.body):candidates.map(c=>String(c.proposed_body)).join('\n');
  const mode=restored?String(restored.adoption_mode):system?'auto':action==='manual'||previous?.adoption_mode==='manual'&&!candidates.length?'manual':'user';
  const formation=restored?'restore':action==='correct'?'correction':action==='change'?'change':action==='manual'?'manual':'adoption';
  tx.run("INSERT INTO memory_version VALUES(?,?,?,?,?,?,?,?,?,?,'present','eligible')",[ownerId,memoryId,versionNo,text,formation,mode,decisionId,previous?.version_no??null,restored?.version_no??null,m?.manual_protection??0n]);
  const sources:StorageRow[]=[];
  if(restored)sources.push(...requireSources(tx,ownerId,{memoryId:memoryId!,versionNo:restored.version_no as bigint},restored.adoption_mode==='manual'));
  else{
   if(previous)sources.push(...requireSources(tx,ownerId,{memoryId:memoryId!,versionNo:previous.version_no as bigint},previous.adoption_mode==='manual'));
   for(const c of candidates)sources.push(...requireSources(tx,ownerId,{candidateId:String(c.id)}));
  }
  const distinct=new Map(sources.map(r=>[JSON.stringify([r.source_contact_id,r.record_id,r.span_start?.toString(),r.span_end?.toString()]),r]));
  evidence(tx,ownerId,{memoryId:memoryId!,versionNo},[...distinct.values()]);
  tx.run("UPDATE memory SET current_version_no=?,head_revision=head_revision+1,state='active' WHERE owner_id=? AND id=?",[versionNo,ownerId,memoryId]);
 }
 advance(tx,ownerId,s);return result(tx,ownerId,tx.get('SELECT * FROM memory_decision WHERE owner_id=? AND id=?',[ownerId,decisionId])!);
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
   catch(error){if(!(error instanceof StorageFailure)||!['memory_relationship_pending','memory_conditions_pending'].includes(error.code))throw error;}
  }
  return {candidateIds:imported.candidateIds,decisions:results};
 }},
 {name:'memory.applyDecision',mode:'write',retryBusy:true,execute:(tx,input)=>applyDecision(tx,input)},
 {name:'memory.applyAutomaticDecision',mode:'write',retryBusy:true,execute:(tx,input)=>applyDecision(tx,input,true)},
 {name:'memory.read',mode:'read',retryBusy:false,execute:managementRead},
];
