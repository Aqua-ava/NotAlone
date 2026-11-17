import {snapshotContinuity} from './source-proof-snapshot.mjs';
import { registry as base } from '../../../src/storage/sqlite/registry.ts';
import { reusableEmptyGoals } from '../../../src/history/sqlite/goal-reuse.ts';

/** 仅供本测试夹具使用的合成数据动作；不是产品路径。 */
export const registry = { ...base, actions: [...base.actions,
  {name:'fixture.protectGoal',mode:'write',retryBusy:false,execute(tx,i){
    const token=i.token;
    if(i.kind==='restore')tx.run(`INSERT INTO history_restore(owner_id,request_key,contact_id,authorization_id,conversation_id,binding_id,verification_id,grant_id,
      selection_generation,barrier_generation,goal_id,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'active',1)`,
      [token.owner_id,i.id,token.contact_id,i.id,token.conversation_id,token.binding_id,token.verification_id,token.grant_id,BigInt(token.selection_generation),BigInt(token.barrier_generation),i.goalId]);
    else throw new Error('synthetic_goal_protection_invalid');
  }},
  {name:'fixture.patchGoal',mode:'write',retryBusy:false,execute(tx,i){
    const allowed=new Set(['cursor','cursor_scope_digest','accepted_data_generation','coverage_state']);
    for(const [key,value] of Object.entries(i.patch)){
      if(!allowed.has(key))throw new Error('synthetic_goal_patch_invalid');
      tx.run(`UPDATE read_goal SET ${key}=? WHERE owner_id=? AND id=?`,[value,i.ownerId,i.goalId]);
    }
  }},
  { name: 'fixture.cloneGoal', mode: 'write', retryBusy: false, execute(tx, i) {
    // 复制一条现有目标并按字段覆写；仅用于隔离验收制造"某一复用条件破坏"的行。
    const source = tx.get('SELECT * FROM read_goal WHERE owner_id=? AND id=?', [i.ownerId, i.goalId]);
    if (!source) throw new Error('clone source missing');
    const patch = i.patch ?? {};
    const row = { ...source, id: i.id, handoff_from_goal_id: null, ...patch };
    const columns = Object.keys(source).filter(column => column !== 'rowid');
    try {
      tx.run(`INSERT INTO read_goal(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
        columns.map(column => {
          const value = row[column];
          if (value === undefined) return null;
          return typeof value === 'bigint' ? value : typeof value === 'number' ? BigInt(value) : value;
        }));
    } catch (error) { return {sqliteError: String(error?.message ?? error), columns}; }
  }},
  { name: 'fixture.seedCaptureRecord', mode: 'write', retryBusy: false, execute(tx, i) {
    // 给指定目标补一条 accepted 空抓取页，可选择补一个 capture_record（将破坏"名下无记录"前提）。
    try {
      tx.run(`INSERT INTO sync_capture(owner_id,id,contact_id,goal_id,read_epoch,runtime_token,captured_at,adapter_version,
        cursor_in,cursor_out,state,response_digest,acceptance_no)
        VALUES(?,?,?,?,1,'rt',1,'1','a','b','accepted',?,(SELECT coalesce(max(acceptance_no),0)+1 FROM sync_capture WHERE acceptance_no IS NOT NULL))`,
        [i.ownerId, i.captureId, i.contactId, i.goalId, 'a'.repeat(64)]);
      if (i.withRecord) tx.run(`INSERT INTO capture_record(owner_id,id,contact_id,capture_id,item_no,state,raw_payload,
        observed_scheme,observed_key,normalizer_version,reason_code)
        VALUES(?,?,?,?,'90','quarantined',?,'source-table-local-v1','wise-key','1','message_state_unverified')`,
        [i.ownerId, i.recordId, i.contactId, i.captureId, JSON.stringify({withRecord: true})]);
    } catch (error) { return {sqliteError: String(error?.message ?? error)}; }
  }},
  { name: 'fixture.reusePreview', mode: 'read', retryBusy: false, execute(tx, i) {
    // 决策点直取：返回当前判据下可续用的空目标行。
    return reusableEmptyGoals(tx, i.token, i.report, i.target).map(goal => ({kind: goal.kind, id: goal.id, cursor: goal.cursor}));
  }},
  { name: 'fixture.listGoals', mode: 'read', retryBusy: false, execute(tx, i) {
    return tx.all(`SELECT id,contact_id,kind,state,failure_code,cursor,pages_accepted,creation_no,created_at,
      binding_id,grant_id,accepted_data_generation,accepted_barrier_generation,cursor_scope_digest,eligibility_json,
      support_json,target_json,resume_cursor FROM read_goal WHERE owner_id=? AND contact_id=? ORDER BY creation_no DESC`, [i.ownerId, i.contactId]);
  }},
  { name: 'fixture.guardLease', mode: 'read', retryBusy: false, execute(tx, i) {
    return snapshotContinuity(tx,i.ownerId).guards;
  }},
  { name: 'fixture.fences', mode: 'read', retryBusy: false, execute(tx, i) {
    return snapshotContinuity(tx,i.ownerId).fences;
  }},
] };
