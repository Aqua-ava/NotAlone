import { registry as current } from '../../../src/storage/sqlite/registry.ts';
import { deletionTargetKey } from '../../../src/storage/sqlite/deletion/actions.ts';

// 47 版存量库：截去 48 号迁移，模拟“已完成操作仍保留逐行台账”的升级前现场。
export const registry = { ...current, migrations: current.migrations.filter(m => m.version <= 47), actions: [
  ...current.actions,
  { name: 'fixture.legacyLedger', mode: 'write', retryBusy: false, execute(tx) {
    const canonical = v => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
    const rowTarget = (rowKind, id) => ({ kind: 'row', domain: 'history', rowKind, key: { owner_id: 'o', id }, identity: 'v1' });
    const fileTarget = { kind: 'file', domain: 'discussion', fileId: 'f1', generation: '1' };
    // 已完成：2 条 message、1 条 capture_record、1 个文件目标，全部 cleared（敏感列已按旧流程封存置空）。
    tx.run("INSERT INTO deletion_operation(operation_id,owner_identity,request_namespace,request_key,scope_kind,contact_identity,source_identity,accepted_generation,state,plan_revision,domain_manifest,created_at,completed_at) VALUES('done-1','o','test','done-1','source','a','r1',0,'completed',1,'[]',0,0)");
    const cleared = [rowTarget('message', 'm1'), rowTarget('message', 'm2'), rowTarget('capture_record', 'c1')];
    for (const [index, target] of cleared.entries())
      tx.run("INSERT INTO deletion_target(operation_id,target_no,storage_kind,domain,target_key,row_kind,row_key_snapshot,expected_identity,target_payload,plan_revision,state) VALUES('done-1',?,'row','history',?,?,NULL,NULL,NULL,1,'cleared')",
        [index + 1, deletionTargetKey(target), target.rowKind]);
    tx.run("INSERT INTO deletion_target(operation_id,target_no,storage_kind,domain,target_key,managed_locator,plan_revision,state) VALUES('done-1',4,'file','discussion',?,'runtime-copies/f1',1,'cleared')",
      [deletionTargetKey(fileTarget)]);
    // 未完成：cleaning 两条 pending（payload 在案）、blocked 一条 failed，迁移后必须原样保留。
    tx.run("INSERT INTO deletion_operation(operation_id,owner_identity,request_namespace,request_key,scope_kind,contact_identity,source_identity,accepted_generation,state,plan_revision,domain_manifest,runner_token,runner_runtime,created_at) VALUES('stuck-1','o','test','stuck-1','source','a','r2',0,'cleaning',1,'[]','old-runner','old-runtime',0)");
    tx.run("INSERT INTO deletion_operation(operation_id,owner_identity,request_namespace,request_key,scope_kind,contact_identity,source_identity,accepted_generation,state,plan_revision,domain_manifest,created_at) VALUES('failed-1','o','test','failed-1','source','a','r3',0,'blocked',1,'[]',0)");
    const pending = [rowTarget('message', 'm9'), rowTarget('message', 'm10')];
    for (const [index, target] of pending.entries())
      tx.run("INSERT INTO deletion_target(operation_id,target_no,storage_kind,domain,target_key,row_kind,row_key_snapshot,expected_identity,target_payload,plan_revision,state) VALUES('stuck-1',?,'row','history',?,'message',?,?,?,1,'pending')",
        [index + 1, deletionTargetKey(target), JSON.stringify(target.key), JSON.stringify('v1'), canonical(target)]);
    const failed = rowTarget('message', 'm11');
    tx.run("INSERT INTO deletion_target(operation_id,target_no,storage_kind,domain,target_key,row_kind,row_key_snapshot,expected_identity,target_payload,plan_revision,state,attempts,last_error_code) VALUES('failed-1',1,'row','history',?,'message',?,?,?,1,'failed',2,'synthetic_cleanup_failed')",
      [deletionTargetKey(failed), JSON.stringify(failed.key), JSON.stringify('v1'), canonical(failed)]);
  } },
] };
