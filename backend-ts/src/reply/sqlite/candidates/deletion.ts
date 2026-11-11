import {sha256StableJson} from '../../../platform/stable-json.ts';
import {StorageFailure,type StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import type {DeletionDomain,DeletionOperation,RowDeletionTarget,CheckResult} from '../../../storage/sqlite/deletion/contracts.ts';
import {collectDiscussionDeletionImpact} from '../deletion.ts';
const domain='reply_candidates';
/** 身份=[domain,ownerId,operationId,id] 纯字符串数组，无键排序语义，序列化不变仅共用哈希入口。 */
export const identity=(op:DeletionOperation,id:string)=>sha256StableJson([domain,op.ownerId,op.operationId,id]);
function collect(tx:StorageTransaction,op:DeletionOperation):RowDeletionTarget[]{
 const impact=collectDiscussionDeletionImpact(tx,op);
 return impact.requestIds.filter(id=>tx.get('SELECT 1 FROM reply_candidate_request WHERE owner_id=? AND request_id=?',[op.ownerId,id])||tx.get('SELECT 1 FROM reply_candidate WHERE owner_id=? AND request_id=?',[op.ownerId,id])||tx.get('SELECT 1 FROM reply_candidate_input x JOIN reply_context c ON c.owner_id=x.owner_id AND c.id=x.context_id WHERE c.owner_id=? AND c.request_id=?',[op.ownerId,id])).map(id=>({kind:'row',domain,rowKind:'reply_candidate_scope',key:{owner_id:op.ownerId,request_id:id},identity:identity(op,id),holderKeys:impact.holderKeys}));
}
/** 候选引用先释放，再按11既有顺序清调用、快照和完整受管副本。 */
export const replyCandidateDeletionDomain:DeletionDomain={
 id:domain,rowKinds:{reply_candidate_scope:{keys:['owner_id','request_id'],ownerKey:'owner_id'}},
 fence(tx,op){
  for(const id of collectDiscussionDeletionImpact(tx,op).requestIds){
   for(const candidate of tx.all('SELECT id FROM reply_candidate WHERE owner_id=? AND request_id=?',[op.ownerId,id])){
    tx.run('DELETE FROM reply_basis WHERE owner_id=? AND candidate_id=?',[op.ownerId,candidate.id]);
    tx.run('DELETE FROM reply_version_part WHERE owner_id=? AND candidate_id=?',[op.ownerId,candidate.id]);
    tx.run("UPDATE reply_candidate_version SET content_state='cleared',call_id=NULL,output_no=NULL WHERE owner_id=? AND candidate_id=? AND content_state='available'",[op.ownerId,candidate.id]);
   }
  }
  return [];
 },collect,
 clearRow(tx,op,target){
  if(target.domain!==domain||target.rowKind!=='reply_candidate_scope'||target.key.owner_id!==op.ownerId||target.identity!==identity(op,target.key.request_id))throw new StorageFailure('reply_deletion_target_invalid');
  const impact=collectDiscussionDeletionImpact(tx,op);
  if(!impact.requestIds.includes(target.key.request_id))return;
  // 同闭包内先释放所有显式携入，避免后续请求仍引用旧选择。
  for(const id of impact.requestIds)tx.run('DELETE FROM reply_candidate_request WHERE owner_id=? AND request_id=?',[op.ownerId,id]);
  for(const id of impact.requestIds){
   tx.run('DELETE FROM reply_selection WHERE owner_id=? AND request_id=?',[op.ownerId,id]);
   for(const k of tx.all('SELECT id FROM reply_candidate WHERE owner_id=? AND request_id=?',[op.ownerId,id])){
    tx.run('DELETE FROM reply_basis WHERE owner_id=? AND candidate_id=?',[op.ownerId,k.id]);
    tx.run('DELETE FROM reply_version_part WHERE owner_id=? AND candidate_id=?',[op.ownerId,k.id]);
    tx.run('DELETE FROM reply_candidate_version WHERE owner_id=? AND candidate_id=?',[op.ownerId,k.id]);
   }
   tx.run('DELETE FROM reply_candidate WHERE owner_id=? AND request_id=?',[op.ownerId,id]);
  }
  for(const contextId of impact.contextIds){
   tx.run('DELETE FROM reply_execution_input WHERE owner_id=? AND context_id=?',[op.ownerId,contextId]);
   tx.run('DELETE FROM reply_candidate_input_source WHERE owner_id=? AND context_id=?',[op.ownerId,contextId]);
   tx.run('DELETE FROM reply_candidate_input WHERE owner_id=? AND context_id=?',[op.ownerId,contextId]);
   tx.run('DELETE FROM reply_candidate_context WHERE owner_id=? AND context_id=?',[op.ownerId,contextId]);
  }
 },
 authorizeFile(){throw new StorageFailure('reply_deletion_has_no_files');},fileCleared(){throw new StorageFailure('reply_deletion_has_no_files');},
 verify(tx,op){const check:CheckResult=collect(tx,op).length?{result:'blocked',proof:'reply_candidate_content_remains'}:{result:'passed',proof:'reply_candidate_closure_cleared'};return {database_rows:check,derived_eligibility:check,trace_payloads:check,request_replay:check,scope_suppression:{result:'not_applicable',proof:'owned_by_identity'}};},
};
