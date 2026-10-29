import {randomUUID} from 'node:crypto';
import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {StorageFailure} from '../../../src/storage/sqlite/contracts.ts';

export const registry={...base,actions:[...base.actions,
 {name:'fixture.effectScopes',mode:'read',retryBusy:false,execute(tx,{ownerId}){
  return tx.all(`SELECT e.operation_id,e.scope_kind,e.contact_id,e.effect_kind,e.state,o.state AS operation_state,o.memory_step_id,o.commit_forbidden_at,
   c.id AS call_id,c.state AS call_state,c.settlement_state,c.reserved_budget_units,c.actual_budget_units,c.receipt
   FROM document_effect_scope e JOIN model_operation o ON o.owner_id=e.owner_id AND o.id=e.operation_id
   JOIN model_call c ON c.owner_id=o.owner_id AND c.operation_id=o.id WHERE e.owner_id=? ORDER BY e.operation_id`,[ownerId]);
 }},
 {name:'fixture.modelCall',mode:'read',retryBusy:false,execute(tx,{ownerId,callId}){
  return tx.get(`SELECT c.*,o.state AS operation_state,o.commit_forbidden_at FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id WHERE c.owner_id=? AND c.id=?`,[ownerId,callId])??null;
 }},
 {name:'fixture.duplicateEffect',mode:'write',retryBusy:false,execute(tx,{ownerId,operationId}){
  const old=tx.get('SELECT * FROM document_effect_scope WHERE owner_id=? AND operation_id=?',[ownerId,operationId]);
  const o=tx.get('SELECT * FROM model_operation WHERE owner_id=? AND id=?',[ownerId,operationId]);
  const id=randomUUID(),slot=tx.get('SELECT coalesce(max(slot),0)+1 AS n FROM model_operation WHERE owner_id=? AND memory_step_id=?',[ownerId,o.memory_step_id]).n;
  tx.run("INSERT INTO model_operation(owner_id,id,purpose,memory_step_id,slot,input_seal,state) VALUES(?,?,?,?,?,?,'prepared')",[ownerId,id,o.purpose,o.memory_step_id,slot,'synthetic']);
  try{tx.run("INSERT INTO document_effect_scope VALUES(?,?,?,?,?,'reserved')",[ownerId,id,old.scope_kind,old.contact_id,old.effect_kind]);}
  catch(error){if(String(error.message).includes('UNIQUE constraint failed: document_effect_scope.'))throw new StorageFailure('fixture_effect_scope_unique');throw error;}
 }},
]};
