import {registry as base} from './reply-provenance-registry.mjs';
import {fenceContinuity} from '../../../src/history/sqlite/continuity.ts';

export const registry={migrations:base.migrations,actions:[...base.actions,
 {name:'sourceRecoveryTest.fence',mode:'write',retryBusy:false,execute(tx,i){return fenceContinuity(tx,i.token);}},
 {name:'sourceRecoveryTest.ready',mode:'write',retryBusy:false,execute(tx,i){
  // 模拟外部来源元数据核验成功；候选、事务和实际模型调用仍走正式实现。
  tx.run("UPDATE history_guard_lease SET state='active',runtime_id=(SELECT runtime_id FROM database_instance WHERE slot=1) WHERE owner_id=? AND contact_id=?",[i.ownerId,i.contactId]);
 }},
]};
