import {registry as base} from './reply-provenance-registry.mjs';
import {assertSourcesEligibility} from '../../../src/history/sqlite/source.ts';
import {fenceContinuity} from '../../../src/history/sqlite/continuity.ts';

export const registry={migrations:base.migrations,actions:[...base.actions,
 {name:'sourceRecoveryTest.strict',mode:'read',retryBusy:false,execute(tx,i){
  const refs=tx.all('SELECT owner_id,contact_id,id record_id,message_id FROM capture_record WHERE owner_id=? AND contact_id=?',[i.ownerId,i.contactId]);assertSourcesEligibility(tx,refs);
 }},
 {name:'sourceRecoveryTest.runtimeState',mode:'write',retryBusy:false,execute(tx,i){
  base.actions.find(a=>a.name==='provenanceTest.guardLost').execute(tx,i);
  if(i.state==='old-runtime')tx.run("UPDATE history_guard_lease SET state='active',runtime_id='previous-runtime' WHERE owner_id=? AND contact_id=?",[i.ownerId,i.contactId]);
  if(i.state==='binding-unverified')tx.run("UPDATE conversation_binding SET state='needs_confirmation' WHERE owner_id=? AND contact_id=?",[i.ownerId,i.contactId]);
 }},
 {name:'sourceRecoveryTest.fence' ,mode:'write',retryBusy:false,execute(tx,i){return fenceContinuity(tx,i.token);}},
 {name:'sourceRecoveryTest.ready',mode:'write',retryBusy:false,execute(tx,i){
  // 模拟外部来源元数据核验成功；候选、事务和实际模型调用仍走正式实现。
  tx.run("UPDATE history_guard_lease SET state='active',runtime_id=(SELECT runtime_id FROM database_instance WHERE slot=1) WHERE owner_id=? AND contact_id=?",[i.ownerId,i.contactId]);
 }},
]};
