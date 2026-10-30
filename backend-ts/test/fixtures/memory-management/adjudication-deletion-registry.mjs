import {registry as base} from './adjudication-registry.mjs';

/** 仅观察真实预约、删除和迟到回调；不伪造生产者或台账。 */
export const registry={...base,actions:[...base.actions,{
 name:'fixture.adjudicationDeletionState',mode:'read',retryBusy:false,
 execute(tx,{ownerId,callId,stepId,attemptId,candidateId}){
  const call=tx.get('SELECT * FROM model_call WHERE owner_id=? AND id=?',[ownerId,callId]);
  return {
   call:call?{...call,receipt:call.receipt===null?null:JSON.parse(call.receipt)}:null,
   operation:call?tx.get('SELECT * FROM model_operation WHERE owner_id=? AND id=?',[ownerId,call.operation_id]):null,
   items:call?tx.all('SELECT * FROM operation_item WHERE owner_id=? AND operation_id=? ORDER BY item_id',[ownerId,call.operation_id]):[],
   scopes:call?tx.all('SELECT * FROM operation_scope WHERE owner_id=? AND operation_id=? ORDER BY source_contact_id',[ownerId,call.operation_id]):[],
   step:tx.get('SELECT * FROM processing_step WHERE owner_id=? AND id=?',[ownerId,stepId]),
   attempt:tx.get('SELECT * FROM step_attempt WHERE owner_id=? AND id=?',[ownerId,attemptId]),
   events:tx.all('SELECT * FROM execution_event WHERE owner_id=? AND step_attempt_id=? ORDER BY event_no',[ownerId,attemptId]),
   inputs:tx.all('SELECT * FROM step_input WHERE owner_id=? AND step_id=? ORDER BY input_no',[ownerId,stepId]),
   candidate:tx.get('SELECT * FROM memory_candidate WHERE owner_id=? AND id=?',[ownerId,candidateId]),
  };
 },
}]};
