import {registry as base} from './discussion-registry.mjs';

export const registry={...base,actions:[...base.actions,
 {name:'unknownTest.inspect',mode:'read',retryBusy:false,execute(tx,i){return {
  calls:tx.all('SELECT * FROM model_call WHERE owner_id=? AND operation_id=? ORDER BY attempt_no',[i.ownerId,i.operationId]),
  operation:tx.get('SELECT * FROM model_operation WHERE owner_id=? AND id=?',[i.ownerId,i.operationId]),
  scopes:tx.all('SELECT * FROM operation_scope WHERE owner_id=? AND operation_id=?',[i.ownerId,i.operationId]),
  attempt:tx.get('SELECT * FROM reply_attempt WHERE owner_id=? AND id=?',[i.ownerId,i.attemptId]),
  request:tx.get('SELECT * FROM reply_request WHERE owner_id=? AND id=?',[i.ownerId,i.requestId]),
  candidates:tx.all('SELECT id FROM reply_candidate WHERE owner_id=? AND request_id=?',[i.ownerId,i.requestId]),
 };}},
 // 只构造升级前已终止、仍被未知调用锁住的合成存量，不触及真实资料。
 {name:'unknownTest.legacy',mode:'write',retryBusy:false,execute(tx,i){
  tx.run("UPDATE model_call SET state='unknown',settlement_state='unknown',error_code='discussion_generation_timeout',receipt=? WHERE owner_id=? AND id=?",[JSON.stringify({format:'dsh-budget-v1',failure:{kind:'error',code:'SERVER',status:503,dispatch:'authorized_unconfirmed'}}),i.ownerId,i.callId]);
  tx.run("UPDATE model_operation SET state='unknown' WHERE owner_id=? AND id=?",[i.ownerId,i.operationId]);
  tx.run("UPDATE operation_scope SET state='unknown' WHERE owner_id=? AND operation_id=?",[i.ownerId,i.operationId]);
  tx.run("UPDATE reply_attempt SET state='failed',error_code='discussion_generation_timeout',finished_at=1 WHERE owner_id=? AND id=?",[i.ownerId,i.attemptId]);
  tx.run("UPDATE reply_request SET state='cancelled' WHERE owner_id=? AND id=?",[i.ownerId,i.requestId]);
 }},
]};
