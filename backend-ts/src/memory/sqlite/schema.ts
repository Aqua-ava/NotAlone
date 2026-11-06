import type { StorageMigration } from '../../storage/sqlite/contracts.ts';
// 复用只认同一逻辑operation的已知回执；INSERT和UPDATE使用相同资格条件。
const reusableCall = `SELECT 1 FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id
 JOIN step_attempt a ON a.owner_id=NEW.owner_id AND a.id=NEW.step_attempt_id
 WHERE c.owner_id=NEW.owner_id AND c.id=NEW.reused_call_id AND c.state='succeeded'
 AND NEW.reply_attempt_id IS NULL AND o.memory_step_id=a.step_id AND o.commit_forbidden_at IS NULL
 UNION ALL
 SELECT 1 FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id
 JOIN reply_attempt a ON a.owner_id=NEW.owner_id AND a.id=NEW.reply_attempt_id
 WHERE c.owner_id=NEW.owner_id AND c.id=NEW.reused_call_id AND c.state='succeeded'
 AND NEW.step_attempt_id IS NULL AND o.reply_request_id=a.request_id AND o.commit_forbidden_at IS NULL`;
/** 版本由集成者追加；不修改任何已经发布的迁移。 */
export const memoryExtractionMigration=(version:number):StorageMigration=>({version,sql:`
CREATE TABLE processing_run (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,start_request_key TEXT NOT NULL,state TEXT NOT NULL,
 intent_revision INTEGER NOT NULL DEFAULT 0,pause_requested_at INTEGER,started_at INTEGER NOT NULL,
 accepted_owner_feedback_revision INTEGER NOT NULL,policy_config TEXT NOT NULL CHECK(json_valid(policy_config)),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,start_request_key),FOREIGN KEY(owner_id) REFERENCES owner(owner_id),
 CHECK(state IN ('preparing','pending','running','paused','failed','incomplete','revoked'))
) STRICT;
CREATE TABLE run_contact (
 owner_id TEXT NOT NULL,run_id TEXT NOT NULL,contact_id TEXT NOT NULL,grant_id TEXT NOT NULL,
 binding_id TEXT NOT NULL,accepted_selection_generation INTEGER NOT NULL,accepted_data_generation INTEGER NOT NULL,
 accepted_identity_generation INTEGER NOT NULL,accepted_account_revision INTEGER NOT NULL,accepted_source_generation TEXT NOT NULL,
 accepted_feedback_revision INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','revoked')),
 PRIMARY KEY(owner_id,run_id,contact_id),FOREIGN KEY(owner_id,run_id) REFERENCES processing_run(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id),FOREIGN KEY(owner_id,grant_id) REFERENCES read_grant(owner_id,id)
) STRICT;
CREATE TABLE processing_item (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,contact_id TEXT NOT NULL,message_id TEXT,purpose TEXT NOT NULL CHECK(purpose='memory_extraction'),
 extraction_state TEXT NOT NULL CHECK(extraction_state IN ('pending','running','succeeded','failed','invalidated','deleted')),
 pipeline_state TEXT NOT NULL CHECK(pipeline_state IN ('pending','deleted')),completion_attempt_id TEXT,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,contact_id,id),FOREIGN KEY(owner_id,contact_id,message_id) REFERENCES message(owner_id,contact_id,id),
 CHECK((message_id IS NULL)=(extraction_state='deleted')),CHECK(completion_attempt_id IS NULL)
) STRICT;
CREATE UNIQUE INDEX processing_item_message ON processing_item(owner_id,contact_id,message_id,purpose) WHERE message_id IS NOT NULL;
CREATE TABLE run_input (
 owner_id TEXT NOT NULL,run_id TEXT NOT NULL,input_no INTEGER NOT NULL,role TEXT NOT NULL CHECK(role IN ('target','context')),
 kind TEXT NOT NULL CHECK(kind='message'),source_contact_id TEXT NOT NULL,item_id TEXT,message_id TEXT NOT NULL,record_id TEXT NOT NULL,
 accepted_interpretation_revision INTEGER NOT NULL,
 PRIMARY KEY(owner_id,run_id,input_no),UNIQUE(owner_id,run_id,message_id),
 FOREIGN KEY(owner_id,run_id,source_contact_id) REFERENCES run_contact(owner_id,run_id,contact_id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,source_contact_id,record_id,message_id) REFERENCES capture_record(owner_id,contact_id,id,message_id),
 FOREIGN KEY(owner_id,source_contact_id,item_id) REFERENCES processing_item(owner_id,contact_id,id),
 CHECK((role='target')=(item_id IS NOT NULL))
) STRICT;
CREATE TABLE processing_task (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,run_id TEXT NOT NULL,scope_kind TEXT NOT NULL CHECK(scope_kind IN ('self','contact')),contact_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('pending','running','paused','failed','unknown','succeeded','revoked','incomplete','awaiting_decision')),
 control_revision INTEGER NOT NULL DEFAULT 0,resume_no INTEGER NOT NULL DEFAULT 0,error_code TEXT,
 document_basis_state TEXT NOT NULL DEFAULT 'pending' CHECK(document_basis_state='pending'),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,id,run_id),FOREIGN KEY(owner_id,run_id) REFERENCES processing_run(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id),CHECK((scope_kind='contact')=(contact_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX task_contact_scope ON processing_task(owner_id,run_id,contact_id) WHERE scope_kind='contact';
CREATE UNIQUE INDEX task_self_scope ON processing_task(owner_id,run_id) WHERE scope_kind='self';
CREATE TABLE task_contribution (
 owner_id TEXT NOT NULL,task_id TEXT NOT NULL,run_id TEXT NOT NULL,source_contact_id TEXT NOT NULL,
 PRIMARY KEY(owner_id,task_id,source_contact_id),
 FOREIGN KEY(owner_id,task_id,run_id) REFERENCES processing_task(owner_id,id,run_id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,run_id,source_contact_id) REFERENCES run_contact(owner_id,run_id,contact_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE processing_step (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,task_id TEXT NOT NULL,step_no INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind='extraction_verification'),
 state TEXT NOT NULL CHECK(state IN ('pending','running','succeeded','failed','unknown','revoked')),input_state TEXT NOT NULL CHECK(input_state='frozen'),successful_attempt_id TEXT,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,task_id,step_no),FOREIGN KEY(owner_id,task_id) REFERENCES processing_task(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,id,successful_attempt_id) REFERENCES step_attempt(owner_id,step_id,id)
) STRICT;
CREATE TABLE step_input (
 owner_id TEXT NOT NULL,step_id TEXT NOT NULL,input_no INTEGER NOT NULL,run_id TEXT NOT NULL,run_input_no INTEGER NOT NULL,
 PRIMARY KEY(owner_id,step_id,input_no),UNIQUE(owner_id,step_id,run_id,run_input_no),
 FOREIGN KEY(owner_id,step_id) REFERENCES processing_step(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,run_id,run_input_no) REFERENCES run_input(owner_id,run_id,input_no)
) STRICT;
CREATE TABLE step_attempt (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,step_id TEXT NOT NULL,attempt_no INTEGER NOT NULL,resume_no INTEGER NOT NULL,
 lease_token TEXT NOT NULL,lease_expires_at INTEGER NOT NULL,accepted_control_revision INTEGER NOT NULL,runtime_token TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed','unknown','aborted')),started_at INTEGER NOT NULL,finished_at INTEGER,error_code TEXT,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,step_id,id),UNIQUE(owner_id,step_id,attempt_no),FOREIGN KEY(owner_id,step_id) REFERENCES processing_step(owner_id,id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX attempt_running ON step_attempt(owner_id,step_id) WHERE state='running';
CREATE TRIGGER step_successful_attempt_insert BEFORE INSERT ON processing_step
 WHEN NEW.successful_attempt_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM step_attempt a WHERE a.owner_id=NEW.owner_id AND a.step_id=NEW.id AND a.id=NEW.successful_attempt_id AND a.state='succeeded')
 BEGIN SELECT RAISE(ABORT,'step_successful_attempt_invalid'); END;
CREATE TRIGGER step_successful_attempt_update BEFORE UPDATE OF owner_id,id,successful_attempt_id ON processing_step
 WHEN NEW.successful_attempt_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM step_attempt a WHERE a.owner_id=NEW.owner_id AND a.step_id=NEW.id AND a.id=NEW.successful_attempt_id AND a.state='succeeded')
 BEGIN SELECT RAISE(ABORT,'step_successful_attempt_invalid'); END;
CREATE TRIGGER successful_attempt_reference BEFORE UPDATE OF owner_id,id,step_id,state ON step_attempt
 WHEN (NEW.owner_id<>OLD.owner_id OR NEW.id<>OLD.id OR NEW.step_id<>OLD.step_id OR NEW.state<>'succeeded')
 AND EXISTS (SELECT 1 FROM processing_step s WHERE s.owner_id=OLD.owner_id AND s.id=OLD.step_id AND s.successful_attempt_id=OLD.id)
 BEGIN SELECT RAISE(ABORT,'successful_attempt_still_referenced'); END;

CREATE TABLE model_operation (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN ('extraction','verification','discussion')),memory_step_id TEXT,
 slot INTEGER NOT NULL,input_seal TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('prepared','in_flight','unknown','resolved','applied','failed','sealed')),
 commit_forbidden_at INTEGER,reply_request_id TEXT,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,memory_step_id,purpose,slot),UNIQUE(owner_id,reply_request_id,purpose,slot),
 FOREIGN KEY(owner_id,memory_step_id) REFERENCES processing_step(owner_id,id),
 FOREIGN KEY(owner_id,reply_request_id) REFERENCES reply_request(owner_id,id),
 CHECK((memory_step_id IS NULL OR reply_request_id IS NULL)
 AND ((state='sealed' AND commit_forbidden_at IS NOT NULL)
 OR (memory_step_id IS NOT NULL AND reply_request_id IS NULL AND purpose IN ('extraction','verification'))
 OR (memory_step_id IS NULL AND reply_request_id IS NOT NULL AND purpose='discussion')))
) STRICT;
CREATE TABLE operation_item (
 owner_id TEXT NOT NULL,operation_id TEXT NOT NULL,item_id TEXT NOT NULL,effect_kind TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('reserved','sent','unknown','released')),
 PRIMARY KEY(owner_id,operation_id,item_id,effect_kind),FOREIGN KEY(owner_id,operation_id) REFERENCES model_operation(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,item_id) REFERENCES processing_item(owner_id,id)
) STRICT;
CREATE UNIQUE INDEX operation_item_occupied ON operation_item(owner_id,item_id,effect_kind) WHERE state IN ('reserved','sent','unknown');
CREATE TABLE model_call (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,operation_id TEXT NOT NULL,attempt_no INTEGER NOT NULL,step_attempt_id TEXT,
 provider TEXT NOT NULL,request_key TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('prepared','sending','succeeded','failed','unknown')),
 receipt_id TEXT,sent_at INTEGER,received_at INTEGER,error_code TEXT,reserved_budget_units INTEGER NOT NULL CHECK(reserved_budget_units>=0),actual_budget_units INTEGER,
 settlement_state TEXT NOT NULL CHECK(settlement_state IN ('reserved','settled','unknown')),receipt TEXT CHECK(receipt IS NULL OR json_valid(receipt)),
 reply_attempt_id TEXT,reply_context_id TEXT,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,operation_id,attempt_no),UNIQUE(provider,request_key),
 FOREIGN KEY(owner_id,operation_id) REFERENCES model_operation(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,step_attempt_id) REFERENCES step_attempt(owner_id,id),
 FOREIGN KEY(owner_id,reply_attempt_id) REFERENCES reply_attempt(owner_id,id),
 FOREIGN KEY(owner_id,reply_attempt_id,reply_context_id) REFERENCES reply_context(owner_id,attempt_id,id),
 CHECK(actual_budget_units IS NULL OR actual_budget_units>=0),
 CHECK((step_attempt_id IS NULL OR reply_attempt_id IS NULL) AND (reply_attempt_id IS NULL)=(reply_context_id IS NULL))
) STRICT;
CREATE TABLE execution_event (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,step_attempt_id TEXT,event_no INTEGER NOT NULL,kind TEXT NOT NULL,
 originated_call_id TEXT,payload TEXT NOT NULL CHECK(json_valid(payload)),payload_format TEXT NOT NULL DEFAULT 'json-v1',
 content_state TEXT NOT NULL DEFAULT 'present' CHECK(content_state='present'),created_at INTEGER NOT NULL,reply_attempt_id TEXT,reused_call_id TEXT,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,step_attempt_id,event_no),UNIQUE(owner_id,reply_attempt_id,event_no),
 FOREIGN KEY(owner_id,step_attempt_id) REFERENCES step_attempt(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,reply_attempt_id) REFERENCES reply_attempt(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,originated_call_id) REFERENCES model_call(owner_id,id),
 FOREIGN KEY(owner_id,reused_call_id) REFERENCES model_call(owner_id,id),
 CHECK(originated_call_id IS NULL OR reused_call_id IS NULL),
 CHECK((step_attempt_id IS NULL)<>(reply_attempt_id IS NULL))
) STRICT;
CREATE TABLE execution_input (
 owner_id TEXT NOT NULL,event_id TEXT NOT NULL,input_no INTEGER NOT NULL,role TEXT NOT NULL,presentation_no INTEGER NOT NULL,
 planned_step_id TEXT,planned_input_no INTEGER,reply_context_id TEXT,context_item_no INTEGER,producer_event_id TEXT,
 PRIMARY KEY(owner_id,event_id,input_no),FOREIGN KEY(owner_id,event_id) REFERENCES execution_event(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,planned_step_id,planned_input_no) REFERENCES step_input(owner_id,step_id,input_no),
 FOREIGN KEY(owner_id,reply_context_id,context_item_no) REFERENCES reply_context_item(owner_id,context_id,item_no),
 FOREIGN KEY(owner_id,producer_event_id) REFERENCES execution_event(owner_id,id) ON DELETE CASCADE,
 CHECK((planned_step_id IS NOT NULL AND planned_input_no IS NOT NULL AND reply_context_id IS NULL AND context_item_no IS NULL AND producer_event_id IS NULL)
 OR (planned_step_id IS NULL AND planned_input_no IS NULL AND reply_context_id IS NOT NULL AND context_item_no IS NOT NULL AND producer_event_id IS NULL)
 OR (planned_step_id IS NULL AND planned_input_no IS NULL AND reply_context_id IS NULL AND context_item_no IS NULL AND producer_event_id IS NOT NULL AND role='verified_contribution'))
) STRICT;
CREATE TABLE event_source (
 owner_id TEXT NOT NULL,event_id TEXT NOT NULL,source_contact_id TEXT NOT NULL,record_id TEXT NOT NULL,
 PRIMARY KEY(owner_id,event_id,record_id),FOREIGN KEY(owner_id,event_id) REFERENCES execution_event(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,source_contact_id,record_id) REFERENCES capture_record(owner_id,contact_id,id)
) STRICT;
CREATE TRIGGER run_input_freeze BEFORE INSERT ON run_input WHEN NOT EXISTS(SELECT 1 FROM processing_run WHERE owner_id=NEW.owner_id AND id=NEW.run_id AND state='preparing')
 BEGIN SELECT RAISE(ABORT,'run_input_frozen'); END;
CREATE TRIGGER run_input_immutable BEFORE UPDATE ON run_input BEGIN SELECT RAISE(ABORT,'run_input_immutable'); END;
CREATE TRIGGER run_contact_immutable BEFORE UPDATE OF grant_id,binding_id,accepted_selection_generation,accepted_data_generation,accepted_identity_generation,accepted_account_revision,accepted_source_generation,accepted_feedback_revision ON run_contact BEGIN SELECT RAISE(ABORT,'run_contact_immutable'); END;
CREATE TRIGGER task_scope_immutable BEFORE UPDATE OF run_id,scope_kind,contact_id ON processing_task BEGIN SELECT RAISE(ABORT,'task_scope_immutable'); END;
CREATE TRIGGER step_input_scope BEFORE INSERT ON step_input WHEN NOT EXISTS (
 SELECT 1 FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
 JOIN run_input i ON i.owner_id=NEW.owner_id AND i.run_id=NEW.run_id AND i.input_no=NEW.run_input_no
 WHERE s.owner_id=NEW.owner_id AND s.id=NEW.step_id AND t.run_id=NEW.run_id AND (t.scope_kind='self' OR t.contact_id=i.source_contact_id))
 BEGIN SELECT RAISE(ABORT,'step_input_scope'); END;
CREATE TRIGGER step_input_immutable BEFORE UPDATE ON step_input BEGIN SELECT RAISE(ABORT,'step_input_immutable'); END;
CREATE TRIGGER execution_input_scope BEFORE INSERT ON execution_input WHEN NOT EXISTS (
 SELECT 1 FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id
 WHERE e.owner_id=NEW.owner_id AND e.id=NEW.event_id AND a.step_id=NEW.planned_step_id
 UNION ALL
 SELECT 1 FROM execution_event e JOIN model_call c ON c.owner_id=e.owner_id AND c.id=e.originated_call_id
 WHERE e.owner_id=NEW.owner_id AND e.id=NEW.event_id AND e.reply_attempt_id=c.reply_attempt_id
 AND c.reply_context_id=NEW.reply_context_id
 UNION ALL
 SELECT 1 FROM execution_event e JOIN model_call c ON c.owner_id=e.owner_id AND c.id=e.reused_call_id
 JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id
 JOIN reply_attempt a ON a.owner_id=e.owner_id AND a.id=e.reply_attempt_id
 WHERE e.owner_id=NEW.owner_id AND e.id=NEW.event_id AND a.request_id=o.reply_request_id AND c.reply_context_id=NEW.reply_context_id
 UNION ALL
 SELECT 1 FROM execution_event result
 JOIN step_attempt ra ON ra.owner_id=result.owner_id AND ra.id=result.step_attempt_id
 JOIN processing_step rs ON rs.owner_id=ra.owner_id AND rs.id=ra.step_id
 JOIN processing_task rt ON rt.owner_id=rs.owner_id AND rt.id=rs.task_id
 JOIN execution_event source ON source.owner_id=result.owner_id AND source.id=NEW.producer_event_id
 JOIN step_attempt sa ON sa.owner_id=source.owner_id AND sa.id=source.step_attempt_id
 JOIN processing_step ss ON ss.owner_id=sa.owner_id AND ss.id=sa.step_id
 JOIN processing_task st ON st.owner_id=ss.owner_id AND st.id=ss.task_id
 JOIN task_contribution tc ON tc.owner_id=rt.owner_id AND tc.task_id=rt.id AND tc.run_id=rt.run_id AND tc.source_contact_id=st.contact_id
 WHERE result.owner_id=NEW.owner_id AND result.id=NEW.event_id AND rt.scope_kind='self' AND rt.contact_id IS NULL
 AND st.scope_kind='contact' AND st.contact_id IS NOT NULL AND st.run_id=rt.run_id AND st.state='succeeded'
 AND result.kind='verified_output' AND source.kind='verified_self_contribution' AND result.payload=source.payload
 AND sa.state='succeeded' AND ss.state='succeeded' AND ss.successful_attempt_id=sa.id
 AND json_extract(source.payload,'$.fact.subject')='self' AND json_extract(source.payload,'$.scopeKind')='self'
 AND json_extract(source.payload,'$.contactId') IS NULL)
 BEGIN SELECT RAISE(ABORT,'execution_input_scope'); END;
CREATE TRIGGER execution_input_immutable BEFORE UPDATE ON execution_input BEGIN SELECT RAISE(ABORT,'execution_input_immutable'); END;
CREATE TRIGGER model_operation_parent_immutable BEFORE UPDATE OF owner_id,purpose,memory_step_id,reply_request_id ON model_operation
 WHEN (NEW.owner_id<>OLD.owner_id OR NEW.purpose<>OLD.purpose
 OR NOT ((NEW.memory_step_id IS OLD.memory_step_id AND NEW.reply_request_id IS OLD.reply_request_id)
 OR (NEW.state='sealed' AND NEW.commit_forbidden_at IS NOT NULL AND NEW.memory_step_id IS NULL AND NEW.reply_request_id IS NULL)))
 BEGIN SELECT RAISE(ABORT,'model_operation_parent_immutable'); END;
CREATE TRIGGER model_call_identity_immutable BEFORE UPDATE OF owner_id,id,operation_id,attempt_no,provider,request_key ON model_call
 BEGIN SELECT RAISE(ABORT,'model_call_identity_immutable'); END;
CREATE TRIGGER model_call_producer BEFORE INSERT ON model_call WHEN NOT EXISTS (
 SELECT 1 FROM model_operation o JOIN step_attempt a ON a.owner_id=o.owner_id AND a.step_id=o.memory_step_id
 WHERE o.owner_id=NEW.owner_id AND o.id=NEW.operation_id AND a.id=NEW.step_attempt_id AND NEW.reply_attempt_id IS NULL
 UNION ALL
 SELECT 1 FROM model_operation o JOIN reply_attempt a ON a.owner_id=o.owner_id AND a.request_id=o.reply_request_id
 JOIN reply_context c ON c.owner_id=a.owner_id AND c.attempt_id=a.id AND c.request_id=a.request_id
 WHERE o.owner_id=NEW.owner_id AND o.id=NEW.operation_id AND a.id=NEW.reply_attempt_id
 AND c.id=NEW.reply_context_id AND c.origin_kind='request' AND NEW.step_attempt_id IS NULL)
 BEGIN SELECT RAISE(ABORT,'model_call_producer'); END;
CREATE TRIGGER model_call_producer_update BEFORE UPDATE OF owner_id,operation_id,step_attempt_id,reply_attempt_id,reply_context_id ON model_call WHEN NOT EXISTS (
 SELECT 1 FROM model_operation o JOIN step_attempt a ON a.owner_id=o.owner_id AND a.step_id=o.memory_step_id
 WHERE o.owner_id=NEW.owner_id AND o.id=NEW.operation_id AND a.id=NEW.step_attempt_id AND NEW.reply_attempt_id IS NULL
 UNION ALL
 SELECT 1 FROM model_operation o JOIN reply_attempt a ON a.owner_id=o.owner_id AND a.request_id=o.reply_request_id
 JOIN reply_context c ON c.owner_id=a.owner_id AND c.attempt_id=a.id AND c.request_id=a.request_id
 WHERE o.owner_id=NEW.owner_id AND o.id=NEW.operation_id AND a.id=NEW.reply_attempt_id
 AND c.id=NEW.reply_context_id AND c.origin_kind='request' AND NEW.step_attempt_id IS NULL
 UNION ALL
 SELECT 1 FROM model_operation o WHERE o.owner_id=NEW.owner_id AND o.id=NEW.operation_id AND o.state='sealed'
 AND o.commit_forbidden_at IS NOT NULL AND NEW.step_attempt_id IS NULL AND NEW.reply_attempt_id IS NULL AND NEW.reply_context_id IS NULL)
 BEGIN SELECT RAISE(ABORT,'model_call_producer'); END;
CREATE TRIGGER event_producer_immutable BEFORE UPDATE OF owner_id,step_attempt_id,reply_attempt_id,originated_call_id ON execution_event
 BEGIN SELECT RAISE(ABORT,'event_producer_immutable'); END;
CREATE TRIGGER event_call_producer BEFORE INSERT ON execution_event WHEN NEW.originated_call_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM model_call c WHERE c.owner_id=NEW.owner_id AND c.id=NEW.originated_call_id
 AND ((c.step_attempt_id=NEW.step_attempt_id AND NEW.reply_attempt_id IS NULL)
 OR (c.reply_attempt_id=NEW.reply_attempt_id AND NEW.step_attempt_id IS NULL)))
 BEGIN SELECT RAISE(ABORT,'event_call_producer'); END;
CREATE TRIGGER event_reused_call_insert BEFORE INSERT ON execution_event
 WHEN NEW.reused_call_id IS NOT NULL AND NOT EXISTS (
 ${reusableCall})
 BEGIN SELECT RAISE(ABORT,'event_reused_call_invalid'); END;
CREATE TRIGGER event_reused_call_update BEFORE UPDATE OF owner_id,step_attempt_id,reply_attempt_id,originated_call_id,reused_call_id ON execution_event
 WHEN NEW.reused_call_id IS NOT NULL AND NOT EXISTS (
 ${reusableCall})
 BEGIN SELECT RAISE(ABORT,'event_reused_call_invalid'); END;
CREATE TRIGGER event_reused_call_immutable BEFORE UPDATE OF reused_call_id ON execution_event
 WHEN NEW.reused_call_id IS NOT OLD.reused_call_id
 BEGIN SELECT RAISE(ABORT,'event_reused_call_immutable'); END;
CREATE TRIGGER event_source_planned BEFORE INSERT ON event_source WHEN NOT EXISTS (
 SELECT 1 FROM execution_input x JOIN step_input si ON si.owner_id=x.owner_id AND si.step_id=x.planned_step_id AND si.input_no=x.planned_input_no
 JOIN run_input i ON i.owner_id=si.owner_id AND i.run_id=si.run_id AND i.input_no=si.run_input_no
 WHERE x.owner_id=NEW.owner_id AND x.event_id=NEW.event_id AND i.record_id=NEW.record_id AND i.source_contact_id=NEW.source_contact_id
 UNION ALL
 SELECT 1 FROM execution_input x JOIN reply_context_item i ON i.owner_id=x.owner_id AND i.context_id=x.reply_context_id AND i.item_no=x.context_item_no
 WHERE x.owner_id=NEW.owner_id AND x.event_id=NEW.event_id AND i.kind='message' AND i.record_id=NEW.record_id AND i.source_contact_id=NEW.source_contact_id
 UNION ALL
 SELECT 1 FROM execution_input x JOIN reply_context_item i ON i.owner_id=x.owner_id AND i.context_id=x.reply_context_id AND i.item_no=x.context_item_no
 JOIN discussion_entry d ON d.owner_id=i.owner_id AND d.id=i.entry_id
 JOIN event_source es ON es.owner_id=d.owner_id AND es.event_id=d.origin_event_id
 WHERE x.owner_id=NEW.owner_id AND x.event_id=NEW.event_id AND i.kind='entry' AND es.record_id=NEW.record_id AND es.source_contact_id=NEW.source_contact_id)
 BEGIN SELECT RAISE(ABORT,'event_source_planned'); END;
CREATE TRIGGER event_source_immutable BEFORE UPDATE ON event_source BEGIN SELECT RAISE(ABORT,'event_source_immutable'); END;
CREATE INDEX execution_input_producer ON execution_input(owner_id,producer_event_id) WHERE producer_event_id IS NOT NULL;
CREATE INDEX run_inputs_source ON run_input(owner_id,source_contact_id,record_id);
CREATE INDEX event_sources_record ON event_source(owner_id,source_contact_id,record_id);
`});

/**
 * 迁移 44：execution_input 对 step_input 的复合外键子列索引。
 * execution_input(owner_id,planned_step_id,planned_input_no) 引用 step_input(owner_id,step_id,input_no)，
 * 子表一侧此前没有任何索引；每删除一行 step_input，SQLite 都要全表扫描 execution_input 核验没有子行
 * （真实库 14.3 万行，单次约 5 毫秒；一个步骤有数千输入时单个 clearTarget 超过 15 秒动作预算而被终止，
 * 该联系人无法删除）。只建索引，不改数据，删除计划的目标集合与顺序不变。
 */
export const memoryExecutionPlannedStepIndexMigration=(version:number):StorageMigration=>({version,sql:`
CREATE INDEX execution_input_planned_step ON execution_input(owner_id,planned_step_id,planned_input_no);
`});
