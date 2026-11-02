import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {backlogRecoveryActions} from '../../../src/memory/sqlite/backlog-recovery.ts';

export const registry={...base,actions:[...base.actions,...backlogRecoveryActions.filter(action=>!base.actions.some(installed=>installed.name===action.name)),{
 name:'fixture.memoryBaseline',mode:'write',retryBusy:false,execute(tx){
  // 仅在合成库模拟升级前已经存在的消息边界，恢复生产的不可变保护。
  tx.run('DROP TRIGGER memory_incremental_baseline_immutable');
  tx.run('UPDATE database_instance SET memory_incremental_baseline_display_no=(SELECT max(display_no) FROM message) WHERE slot=1');
  tx.run("CREATE TRIGGER memory_incremental_baseline_immutable BEFORE UPDATE OF memory_incremental_baseline_display_no ON database_instance BEGIN SELECT RAISE(ABORT,'memory_incremental_baseline_immutable'); END");
 }
},{
 name:'fixture.backlogStalePolicy',mode:'write',retryBusy:false,execute(tx,input){
  tx.run("UPDATE processing_run SET policy_config=json_set(policy_config,'$.source_stamp',?) WHERE owner_id=? AND id=?",['a'.repeat(64),input.ownerId,input.runId]);
 }
},{
 name:'fixture.backlogPause',mode:'write',retryBusy:false,execute(tx,input){
  // 只在隔离合成库重现旧版本无法区分来源的持久暂停；不建立产品写入口。
  tx.run("UPDATE processing_run SET state='paused',pause_requested_at=?,intent_revision=intent_revision+1 WHERE owner_id=? AND id=?",[Date.now(),input.ownerId,input.runId]);
 }
}]};
