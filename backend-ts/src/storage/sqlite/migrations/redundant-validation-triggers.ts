import type {StorageMigration} from '../contracts.ts';

/** 迁移49：正式写入口已完成同范围和执行链复验，移除重复的逐行查询。
 * 旧迁移保持冻结；不可变锚、撤销终态及来源引用和派生维护仍由原约束保护。
 * Skill 默认启用的修订可用性检查同时移至 skills.defaultEnable 正式入口。
 */
export const redundantValidationTriggersMigration=(version:number):StorageMigration=>({version,sql:`
DROP TRIGGER candidate_real_producer;
DROP TRIGGER memory_version_decision;
DROP TRIGGER auto_noop_execution;
DROP TRIGGER decision_candidate_scope;
DROP TRIGGER capture_record_binding;
DROP TRIGGER grant_verification_generation;
DROP TRIGGER media_head_kind;
DROP TRIGGER skill_default_enabled_update_guard;
DROP TRIGGER reply_version_call;
DROP TRIGGER reply_execution_input_scope;
DROP TRIGGER runtime_context_scope;
DROP TRIGGER runtime_commit_request;
DROP TRIGGER adjudication_operation_step;
DROP TRIGGER document_task_basis_fixed;
DROP TRIGGER document_basis_producer;
DROP TRIGGER document_producer_scope;
DROP TRIGGER document_publication_scope;
DROP TRIGGER document_member_scope;

-- 已标脏时不再重写同一 memory 行；补回原嵌套更新产生的修订增量。
-- 未标脏时仍由原 memory 管理触发器处理首次写入，两个范围的增量均保持不变。
DROP TRIGGER memory_timeline_update;
CREATE TRIGGER memory_timeline_update AFTER UPDATE OF current_version_no,state ON memory BEGIN
 UPDATE owner SET management_revision=management_revision+1
  WHERE owner_id=NEW.owner_id AND NEW.scope_kind='self' AND NEW.management_timeline_dirty=1;
 UPDATE contact SET management_revision=management_revision+1
  WHERE owner_id=NEW.owner_id AND id=NEW.contact_id AND NEW.scope_kind='contact' AND NEW.management_timeline_dirty=1;
 UPDATE memory SET management_timeline_dirty=1
  WHERE owner_id=NEW.owner_id AND id=NEW.id AND management_timeline_dirty=0;
END;
`});
