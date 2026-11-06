import {registry as base} from './registry.mjs';

/** 共享读取器来源失证回归夹具：只增加读取持久守卫/围栏/目标状态与模拟实例运行代次迁移的合成动作。 */
export const registry={...base,actions:[...base.actions,
 {name:'fixture.continuityState',mode:'read',retryBusy:false,execute(tx,i){
  const rows=sql=>tx.all(sql,[i.ownerId]);
  return {
   runtimeId:String(tx.get('SELECT runtime_id FROM database_instance WHERE slot=1').runtime_id),
   fences:rows('SELECT contact_id,reason FROM history_continuity_fence WHERE owner_id=?').map(row=>({contactId:String(row.contact_id),reason:String(row.reason)})),
   leases:rows('SELECT contact_id,state,runtime_id,guard_id FROM history_guard_lease WHERE owner_id=?').map(row=>({contactId:String(row.contact_id),state:String(row.state),runtimeId:String(row.runtime_id),guardId:String(row.guard_id)})),
   goals:rows(`SELECT contact_id,id,kind,state,failure_code FROM read_goal WHERE owner_id=? ORDER BY created_at,id`).map(row=>({contactId:String(row.contact_id),id:String(row.id),kind:String(row.kind),state:String(row.state),failureCode:row.failure_code===null?null:String(row.failure_code)})),
  };
 }},
]};
