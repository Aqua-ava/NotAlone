import type {StorageMigration} from '../../storage/sqlite/contracts.ts';
/** 独立后续迁移，保留首份共享DDL检查点。 */
export const memoryExecutionMigration=(version:number):StorageMigration=>({version,sql:`
CREATE TABLE operation_scope (
 owner_id TEXT NOT NULL,operation_id TEXT NOT NULL,source_contact_id TEXT NOT NULL,effect_kind TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('reserved','sent','unknown','released')),
 PRIMARY KEY(owner_id,operation_id,source_contact_id,effect_kind),
 FOREIGN KEY(owner_id,operation_id) REFERENCES model_operation(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,source_contact_id) REFERENCES contact(owner_id,id)
) STRICT;
ALTER TABLE model_call ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE model_call ADD COLUMN configuration_id TEXT NOT NULL DEFAULT '';
ALTER TABLE model_call ADD COLUMN input_cap INTEGER NOT NULL DEFAULT 0 CHECK(input_cap>=0);
ALTER TABLE model_call ADD COLUMN output_cap INTEGER NOT NULL DEFAULT 0 CHECK(output_cap>=0);
CREATE TABLE execution_reuse (
 owner_id TEXT NOT NULL,event_id TEXT NOT NULL,call_id TEXT NOT NULL,
 PRIMARY KEY(owner_id,event_id),FOREIGN KEY(owner_id,event_id) REFERENCES execution_event(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,call_id) REFERENCES model_call(owner_id,id)
) STRICT;
CREATE TRIGGER reused_call_scope BEFORE INSERT ON execution_reuse WHEN NOT EXISTS (
 SELECT 1 FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id
 JOIN execution_event e ON e.owner_id=NEW.owner_id AND e.id=NEW.event_id
 JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id
 WHERE c.owner_id=NEW.owner_id AND c.id=NEW.call_id AND c.state='succeeded' AND e.originated_call_id IS NULL AND o.memory_step_id=a.step_id AND o.commit_forbidden_at IS NULL
 UNION ALL
 SELECT 1 FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id
 JOIN execution_event e ON e.owner_id=NEW.owner_id AND e.id=NEW.event_id
 JOIN reply_attempt a ON a.owner_id=e.owner_id AND a.id=e.reply_attempt_id
 WHERE c.owner_id=NEW.owner_id AND c.id=NEW.call_id AND c.state='succeeded' AND e.originated_call_id IS NULL AND o.reply_request_id=a.request_id AND o.commit_forbidden_at IS NULL)
 BEGIN SELECT RAISE(ABORT,'reused_call_scope'); END;
`});
