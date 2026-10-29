import type { StorageMigration } from '../../storage/sqlite/contracts.ts';
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
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,task_id,step_no),FOREIGN KEY(owner_id,task_id) REFERENCES processing_task(owner_id,id) ON DELETE CASCADE
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
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,step_id,attempt_no),FOREIGN KEY(owner_id,step_id) REFERENCES processing_step(owner_id,id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX attempt_running ON step_attempt(owner_id,step_id) WHERE state='running';
CREATE TABLE model_operation (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN ('extraction','verification')),memory_step_id TEXT,
 slot INTEGER NOT NULL,input_seal TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('prepared','in_flight','unknown','resolved','applied','failed','sealed')),
 commit_forbidden_at INTEGER,PRIMARY KEY(owner_id,id),UNIQUE(owner_id,memory_step_id,purpose,slot),
 FOREIGN KEY(owner_id,memory_step_id) REFERENCES processing_step(owner_id,id),CHECK(memory_step_id IS NOT NULL OR state='sealed')
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
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,operation_id,attempt_no),UNIQUE(provider,request_key),
 FOREIGN KEY(owner_id,operation_id) REFERENCES model_operation(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,step_attempt_id) REFERENCES step_attempt(owner_id,id),CHECK(actual_budget_units IS NULL OR actual_budget_units>=0)
) STRICT;
CREATE TABLE execution_event (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,step_attempt_id TEXT NOT NULL,event_no INTEGER NOT NULL,kind TEXT NOT NULL,
 originated_call_id TEXT,payload TEXT NOT NULL CHECK(json_valid(payload)),payload_format TEXT NOT NULL DEFAULT 'json-v1',
 content_state TEXT NOT NULL DEFAULT 'present' CHECK(content_state='present'),created_at INTEGER NOT NULL,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,step_attempt_id,event_no),
 FOREIGN KEY(owner_id,step_attempt_id) REFERENCES step_attempt(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,originated_call_id) REFERENCES model_call(owner_id,id)
) STRICT;
CREATE TABLE execution_input (
 owner_id TEXT NOT NULL,event_id TEXT NOT NULL,input_no INTEGER NOT NULL,role TEXT NOT NULL,presentation_no INTEGER NOT NULL,
 planned_step_id TEXT NOT NULL,planned_input_no INTEGER NOT NULL,
 PRIMARY KEY(owner_id,event_id,input_no),FOREIGN KEY(owner_id,event_id) REFERENCES execution_event(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,planned_step_id,planned_input_no) REFERENCES step_input(owner_id,step_id,input_no)
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
 WHERE e.owner_id=NEW.owner_id AND e.id=NEW.event_id AND a.step_id=NEW.planned_step_id)
 BEGIN SELECT RAISE(ABORT,'execution_input_scope'); END;
CREATE TRIGGER model_call_producer BEFORE INSERT ON model_call WHEN NOT EXISTS (
 SELECT 1 FROM model_operation o JOIN step_attempt a ON a.owner_id=o.owner_id AND a.step_id=o.memory_step_id
 WHERE o.owner_id=NEW.owner_id AND o.id=NEW.operation_id AND a.id=NEW.step_attempt_id)
 BEGIN SELECT RAISE(ABORT,'model_call_producer'); END;
CREATE TRIGGER event_call_producer BEFORE INSERT ON execution_event WHEN NEW.originated_call_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM model_call c WHERE c.owner_id=NEW.owner_id AND c.id=NEW.originated_call_id AND c.step_attempt_id=NEW.step_attempt_id)
 BEGIN SELECT RAISE(ABORT,'event_call_producer'); END;
CREATE TRIGGER event_source_planned BEFORE INSERT ON event_source WHEN NOT EXISTS (
 SELECT 1 FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id
 JOIN step_input si ON si.owner_id=a.owner_id AND si.step_id=a.step_id
 JOIN run_input i ON i.owner_id=si.owner_id AND i.run_id=si.run_id AND i.input_no=si.run_input_no
 WHERE e.owner_id=NEW.owner_id AND e.id=NEW.event_id AND i.record_id=NEW.record_id AND i.source_contact_id=NEW.source_contact_id)
 BEGIN SELECT RAISE(ABORT,'event_source_planned'); END;
CREATE INDEX run_inputs_source ON run_input(owner_id,source_contact_id,record_id);
CREATE INDEX event_sources_record ON event_source(owner_id,source_contact_id,record_id);
`});
