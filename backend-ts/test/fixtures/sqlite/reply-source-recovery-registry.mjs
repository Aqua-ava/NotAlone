import {simulateSourceGuard} from '../history/runtime-guard-fixture.mjs';
import {registry as base} from './reply-provenance-registry.mjs';
import {assertSourcesEligibility} from '../../../src/history/sqlite/source.ts';
import {fenceContinuity} from '../../../src/history/sqlite/continuity.ts';

export const registry={migrations:base.migrations,actions:[...base.actions,
 {name:'sourceRecoveryTest.strict',mode:'read',retryBusy:false,execute(tx,i){
  const refs=tx.all('SELECT owner_id,contact_id,id record_id,message_id FROM capture_record WHERE owner_id=? AND contact_id=?',[i.ownerId,i.contactId]);assertSourcesEligibility(tx,refs);
 }},
 {name:'sourceRecoveryTest.runtimeState',mode:'write',retryBusy:false,execute(tx,i){
  base.actions.find(a=>a.name==='provenanceTest.guardLost').execute(tx,i);
  if(i.state==='old-runtime')simulateSourceGuard(tx,{ownerId:i.ownerId,contactId:i.contactId,state:'active',runtimeId:'previous-runtime'});
  if(i.state==='binding-unverified')tx.run("UPDATE conversation_binding SET state='needs_confirmation' WHERE owner_id=? AND contact_id=?",[i.ownerId,i.contactId]);
  if(i.state==='binding-revoked')tx.run("UPDATE conversation_binding SET state='revoked' WHERE owner_id=? AND contact_id=?",[i.ownerId,i.contactId]);
 }},
 {name:'sourceRecoveryTest.fence' ,mode:'write',retryBusy:false,execute(tx,i){return fenceContinuity(tx,i.token,'L01');}},
 {name:'sourceRecoveryTest.ready',mode:'write',retryBusy:false,execute(tx,i){
  // 仅恢复合成渠道的易失守卫，不修改source_proof或已保存来源资格。
  simulateSourceGuard(tx,{ownerId:i.ownerId,contactId:i.contactId,state:'active'});
 }},
]};
