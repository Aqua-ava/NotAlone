import {snapshotContinuity} from './source-proof-snapshot.mjs';
import {registry as base} from './registry.mjs';

/** 共享读取器来源失证回归夹具：只增加读取持久守卫/围栏/目标状态与模拟实例运行代次迁移的合成动作。 */
export const registry={...base,actions:[...base.actions,
 {name:'fixture.continuityState',mode:'read',retryBusy:false,execute(tx,i){
  const rows=sql=>tx.all(sql,[i.ownerId]);
  return {
   proofs:snapshotContinuity(tx,i.ownerId).proofs,
   runtimeId:String(tx.get('SELECT runtime_id FROM database_instance WHERE slot=1').runtime_id),
   fences:snapshotContinuity(tx,i.ownerId).fences.map(row=>({contactId:String(row.contact_id),reason:String(row.reason)})),
   leases:snapshotContinuity(tx,i.ownerId).guards.map(row=>({contactId:String(row.contact_id),state:String(row.state),runtimeId:String(row.runtime_id),guardId:String(row.guard_id)})),
   goals:rows(`SELECT contact_id,id,kind,state,failure_code FROM read_goal WHERE owner_id=? ORDER BY created_at,id`).map(row=>({contactId:String(row.contact_id),id:String(row.id),kind:String(row.kind),state:String(row.state),failureCode:row.failure_code===null?null:String(row.failure_code)})),
  };
 }},
]};
