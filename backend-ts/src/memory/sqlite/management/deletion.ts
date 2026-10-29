import {createHash} from 'node:crypto';
import type {StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import type {DeletionDomain,DeletionOperation,RowDeletionTarget,CheckResult} from '../../../storage/sqlite/deletion/contracts.ts';
import {identityDeletionAuthority} from '../../../contacts/sqlite/deletion.ts';
import {fail} from './qualification.ts';
const domain='memory_management';
const rowKinds:DeletionDomain['rowKinds']={memory_candidate:{keys:['owner_id','id'],ownerKey:'owner_id'},memory_version:{keys:['owner_id','memory_id','version_no'],ownerKey:'owner_id'},memory:{keys:['owner_id','id'],ownerKey:'owner_id'}};
const allowed=(op:DeletionOperation)=>['source','contact_history','contact','account'].includes(op.scope.kind);
const identity=(kind:string,key:Record<string,string>)=>createHash('sha256').update(JSON.stringify([domain,kind,Object.entries(key).sort(([a],[b])=>a.localeCompare(b))])).digest('hex');
function target(rowKind:string,key:Record<string,string>):RowDeletionTarget{return {kind:'row',domain,rowKind,key,identity:identity(rowKind,key),holderKeys:[]};}
function planned(tx:StorageTransaction,op:DeletionOperation):RowDeletionTarget[]{return tx.all('SELECT target_payload FROM deletion_target WHERE operation_id=? AND domain=? AND target_payload IS NOT NULL',[op.operationId,domain]).map(r=>JSON.parse(String(r.target_payload)) as RowDeletionTarget);}
function collect(tx:StorageTransaction,op:DeletionOperation):RowDeletionTarget[]{
 if(!allowed(op))return [];const {ownerId,scope}=op;
 const candidates=new Set<string>(),versions=new Set<string>(),memories=new Set<string>();
 const pair=(memory:unknown,version:unknown)=>JSON.stringify([String(memory),String(version)]);
 if(scope.kind==='account'){
  for(const c of tx.all("SELECT id FROM memory_candidate WHERE owner_id=? AND state<>'deleted'",[ownerId]))candidates.add(String(c.id));
  for(const m of tx.all('SELECT id FROM memory WHERE owner_id=?',[ownerId]))memories.add(String(m.id));
 }else if('contactId'in scope){
  // 完整冻结贡献决定本人资格，不能只沿单event所用的那位联系人反查。
  const sourceFilter=scope.kind==='source'?'AND i.record_id=?':'AND rc.accepted_data_generation<?';
  const producer=tx.all(`SELECT DISTINCT c.id FROM memory_candidate c
   JOIN step_attempt a ON a.owner_id=c.owner_id AND a.id=c.produced_attempt_id
   JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
   JOIN task_contribution tc ON tc.owner_id=s.owner_id AND tc.task_id=s.task_id
   JOIN run_contact rc ON rc.owner_id=tc.owner_id AND rc.run_id=tc.run_id AND rc.contact_id=tc.source_contact_id
   JOIN run_input i ON i.owner_id=tc.owner_id AND i.run_id=tc.run_id AND i.source_contact_id=tc.source_contact_id
   WHERE tc.owner_id=? AND tc.source_contact_id=? ${sourceFilter}`,[ownerId,scope.contactId,scope.kind==='source'?scope.sourceId:op.acceptedGeneration]);
  for(const c of producer)candidates.add(String(c.id));
  for(const c of tx.all(`SELECT candidate_id,memory_id,version_no FROM memory_citation WHERE owner_id=? AND source_contact_id=? ${scope.kind==='source'?'AND record_id=?':''}`,scope.kind==='source'?[ownerId,scope.contactId,scope.sourceId]:[ownerId,scope.contactId])){
   if(c.candidate_id)candidates.add(String(c.candidate_id));if(c.memory_id)versions.add(pair(c.memory_id,c.version_no));
  }
  if(scope.kind==='contact'){
   for(const c of tx.all("SELECT id FROM memory_candidate WHERE owner_id=? AND contact_id=? AND state<>'deleted'",[ownerId,scope.contactId]))candidates.add(String(c.id));
   for(const m of tx.all('SELECT id FROM memory WHERE owner_id=? AND contact_id=?',[ownerId,scope.contactId]))memories.add(String(m.id));
  }
 }
 for(const candidateId of candidates)for(const v of tx.all(`SELECT v.memory_id,v.version_no FROM decision_candidate c JOIN memory_version v ON v.owner_id=c.owner_id AND v.decision_id=c.decision_id WHERE c.owner_id=? AND c.candidate_id=?`,[ownerId,candidateId]))versions.add(pair(v.memory_id,v.version_no));
 // 计划身份固定接受时闭包；引用先清除也不丢失尚未擦除的正文。
 for(const old of planned(tx,op)){
  if(old.rowKind==='memory_candidate')candidates.add(old.key.id);
  if(old.rowKind==='memory_version')versions.add(pair(old.key.memory_id,old.key.version_no));
  if(old.rowKind==='memory')memories.add(old.key.id);
 }
 // 修正和恢复继承原始producer的完整贡献，不能用新版citation洗掉旧证明。
 for(const encoded of [...versions]){
  const [memoryId,versionNo]=JSON.parse(encoded) as string[];
  for(const v of tx.all(`WITH RECURSIVE affected(version_no) AS (SELECT ? UNION SELECT v.version_no FROM memory_version v JOIN affected a ON v.previous_version_no=a.version_no OR v.restored_from_version_no=a.version_no WHERE v.owner_id=? AND v.memory_id=?) SELECT version_no FROM affected`,[BigInt(versionNo),ownerId,memoryId]))versions.add(pair(memoryId,v.version_no));
 }
 const result:RowDeletionTarget[]=[];
 for(const candidateId of candidates)if(tx.get("SELECT 1 FROM memory_candidate WHERE owner_id=? AND id=? AND state<>'deleted'",[ownerId,candidateId]))result.push(target('memory_candidate',{owner_id:ownerId,id:candidateId}));
 for(const encoded of versions){const [memoryId,versionNo]=JSON.parse(encoded) as string[];if(!memories.has(memoryId)&&tx.get("SELECT 1 FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=? AND content_state='present'",[ownerId,memoryId,BigInt(versionNo)]))result.push(target('memory_version',{owner_id:ownerId,memory_id:memoryId,version_no:versionNo}));}
 for(const memoryId of memories)if(tx.get('SELECT 1 FROM memory WHERE owner_id=? AND id=?',[ownerId,memoryId]))result.push(target('memory',{owner_id:ownerId,id:memoryId}));
 return result;
}
function redactDecision(tx:StorageTransaction,ownerId:string,decisionId:string):void{tx.run("UPDATE memory_decision SET execution_id=NULL,request_seal=NULL,outcome='redacted' WHERE owner_id=? AND id=?",[ownerId,decisionId]);}
function eraseVersion(tx:StorageTransaction,ownerId:string,memoryId:string,versionNo:bigint):void{
 const v=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,memoryId,versionNo]);if(!v)return;
 tx.run('DELETE FROM memory_citation WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,memoryId,versionNo]);tx.run('DELETE FROM memory_required_message WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,memoryId,versionNo]);
 if(v.content_state==='present')tx.run("UPDATE memory_version SET body=NULL,content_state='redacted',provenance_state='invalidated' WHERE owner_id=? AND memory_id=? AND version_no=?",[ownerId,memoryId,versionNo]);
 redactDecision(tx,ownerId,String(v.decision_id));
 tx.run("UPDATE memory SET state='invalidated',head_revision=head_revision+1 WHERE owner_id=? AND id=? AND current_version_no=? AND state<>'invalidated'",[ownerId,memoryId,versionNo]);
}
export const memoryManagementDeletionDomain:DeletionDomain={id:domain,rowKinds,
 fence(tx,op){
  const targets=collect(tx,op),keys=new Set<string>();
  for(const t of targets){
   if(t.rowKind==='memory_candidate')for(const d of tx.all('SELECT d.request_key FROM memory_decision d JOIN decision_candidate c ON c.owner_id=d.owner_id AND c.decision_id=d.id WHERE c.owner_id=? AND c.candidate_id=?',[op.ownerId,t.key.id]))keys.add(String(d.request_key));
   else for(const d of tx.all('SELECT request_key FROM memory_decision WHERE owner_id=? AND target_memory_id=?',[op.ownerId,t.key.memory_id??t.key.id]))keys.add(String(d.request_key));
  }
  return [...keys].map(key=>({namespace:'memory.applyDecision',key}));
 },collect,
 clearRow(tx,op,t){
  if(!allowed(op)||t.domain!==domain||!Object.hasOwn(rowKinds,t.rowKind)||t.key.owner_id!==op.ownerId||Object.keys(t.key).sort().join()!==[...rowKinds[t.rowKind].keys].sort().join()||t.identity!==identity(t.rowKind,t.key))fail('memory_deletion_target_invalid');
  if(identityDeletionAuthority.verify(tx,op).result!=='passed'||!tx.get('SELECT 1 FROM deletion_target WHERE operation_id=? AND domain=? AND expected_identity=?',[op.operationId,domain,JSON.stringify(t.identity)]))fail('memory_deletion_not_fenced');
  const ownerId=op.ownerId;
  if(t.rowKind==='memory_candidate'){
   for(const d of tx.all('SELECT decision_id FROM decision_candidate WHERE owner_id=? AND candidate_id=?',[ownerId,t.key.id]))redactDecision(tx,ownerId,String(d.decision_id));
   tx.run('DELETE FROM memory_citation WHERE owner_id=? AND candidate_id=?',[ownerId,t.key.id]);tx.run('DELETE FROM memory_required_message WHERE owner_id=? AND candidate_id=?',[ownerId,t.key.id]);
   tx.run("UPDATE memory_candidate SET state='deleted',state_revision=state_revision+1,proposed_body=NULL,event_id=NULL,produced_attempt_id=NULL WHERE owner_id=? AND id=? AND state<>'deleted'",[ownerId,t.key.id]);
   if(op.scope.kind==='account'||op.scope.kind==='contact'&&tx.get('SELECT 1 FROM memory_candidate WHERE owner_id=? AND id=? AND contact_id=?',[ownerId,t.key.id,op.scope.contactId])){
    tx.run('DELETE FROM decision_candidate WHERE owner_id=? AND candidate_id=?',[ownerId,t.key.id]);tx.run('DELETE FROM memory_candidate WHERE owner_id=? AND id=?',[ownerId,t.key.id]);
   }
  }else if(t.rowKind==='memory_version')eraseVersion(tx,ownerId,t.key.memory_id,BigInt(t.key.version_no));
  else{
   const memoryId=t.key.id;
   for(const v of tx.all('SELECT version_no FROM memory_version WHERE owner_id=? AND memory_id=?',[ownerId,memoryId]))eraseVersion(tx,ownerId,memoryId,v.version_no as bigint);
   tx.run('DELETE FROM decision_candidate WHERE owner_id=? AND decision_id IN (SELECT id FROM memory_decision WHERE owner_id=? AND target_memory_id=?)',[ownerId,ownerId,memoryId]);
   tx.run('DELETE FROM memory_version WHERE owner_id=? AND memory_id=?',[ownerId,memoryId]);tx.run('DELETE FROM memory_decision WHERE owner_id=? AND target_memory_id=?',[ownerId,memoryId]);tx.run('DELETE FROM memory WHERE owner_id=? AND id=?',[ownerId,memoryId]);
  }
 },authorizeFile(){fail('memory_management_has_no_files');},fileCleared(){fail('memory_management_has_no_files');},
 verify(tx,op){const check:CheckResult=!allowed(op)?{result:'not_applicable',proof:'memory_scope_not_owned'}:{result:collect(tx,op).length===0?'passed':'blocked',proof:'memory_content_and_dependencies_cleared'};return {database_rows:check,derived_eligibility:check,trace_payloads:check,request_replay:check,scope_suppression:check};},
};
