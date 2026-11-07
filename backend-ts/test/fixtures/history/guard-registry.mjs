import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {getSourceGuard} from '../../../src/history/sqlite/source-guard.ts';
import {putScope} from '../../../src/history/sqlite/source-proof.ts';
import {snapshotContinuity} from './source-proof-snapshot.mjs';
import {simulateSourceGuard} from './runtime-guard-fixture.mjs';

// 只准备合成初始事实和观测结果；恢复/拒绝均通过正式history action执行。
export const registry={...base,actions:[...base.actions,
 {name:'fixture.guardSeedEmpty',mode:'write',retryBusy:false,execute(tx,i){
  putScope(tx,i.token,'',{state:'needs_confirmation'});
  simulateSourceGuard(tx,{ownerId:i.token.owner_id,contactId:i.token.contact_id,state:'lost'});return null;
 }},
 {name:'fixture.guardSeedExclusion',mode:'write',retryBusy:false,execute(tx,i){
  tx.run("INSERT INTO history_source_exclusion VALUES(?,?,'local',?,?)",[i.token.owner_id,i.token.conversation_id,
   JSON.stringify([i.token.source_generation,'shard-a','table-instance-1','7']),'synthetic-exclusion']);return null;
 }},
 {name:'fixture.guardSnapshot',mode:'read',retryBusy:false,execute(tx,i){return {
  ...snapshotContinuity(tx,i.ownerId,i.contactId),
  guardAtKey:getSourceGuard(tx,i.ownerId,i.contactId)??null,
  counts:Object.fromEntries(['read_goal','sync_capture','capture_record','message','message_alias','history_source_exclusion'].map(table=>
   [table,tx.get(`SELECT count(*) n FROM ${table} WHERE owner_id=?`,[i.ownerId]).n])),
  exclusions:tx.all('SELECT conversation_id,scheme,external_key FROM history_source_exclusion WHERE owner_id=? ORDER BY conversation_id,scheme,external_key',[i.ownerId]),
 };}},
]};
