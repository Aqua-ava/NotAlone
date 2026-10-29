import type {StorageMigration} from '../../../storage/sqlite/contracts.ts';
/** 独立追加版本；不修改已发布的提取与执行迁移。 */
export const memoryManagementMigration=(version:number):StorageMigration=>({version,sql:`
CREATE TABLE memory_candidate (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,scope_kind TEXT NOT NULL CHECK(scope_kind IN ('self','contact')),contact_id TEXT,
 proposed_body TEXT,produced_attempt_id TEXT,event_id TEXT,output_no INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','adopted','rejected','invalidated','deleted')),state_revision INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,produced_attempt_id,output_no),UNIQUE(owner_id,event_id),
 FOREIGN KEY(owner_id) REFERENCES owner(owner_id),FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id),
 FOREIGN KEY(owner_id,produced_attempt_id) REFERENCES step_attempt(owner_id,id),FOREIGN KEY(owner_id,event_id) REFERENCES execution_event(owner_id,id),
 CHECK((scope_kind='self' AND contact_id IS NULL) OR (scope_kind='contact' AND contact_id IS NOT NULL)),
 CHECK((state='deleted' AND proposed_body IS NULL AND produced_attempt_id IS NULL AND event_id IS NULL) OR (state<>'deleted' AND proposed_body IS NOT NULL AND produced_attempt_id IS NOT NULL AND event_id IS NOT NULL))
) STRICT;
CREATE TRIGGER candidate_real_producer BEFORE INSERT ON memory_candidate WHEN NOT EXISTS(
 SELECT 1 FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id
 JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
 WHERE e.owner_id=NEW.owner_id AND e.id=NEW.event_id AND e.step_attempt_id=NEW.produced_attempt_id AND e.event_no=NEW.output_no
 AND e.kind='verified_output' AND a.state='succeeded' AND s.successful_attempt_id=a.id AND s.state='succeeded'
 AND t.scope_kind=NEW.scope_kind AND t.contact_id IS NEW.contact_id AND json_extract(e.payload,'$.fact.text')=NEW.proposed_body)
 BEGIN SELECT RAISE(ABORT,'memory_candidate_producer_mismatch'); END;
CREATE TABLE memory (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,scope_kind TEXT NOT NULL CHECK(scope_kind IN ('self','contact')),contact_id TEXT,
 current_version_no INTEGER,head_revision INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL CHECK(state IN ('active','withdrawn','invalidated')),
 manual_protection INTEGER NOT NULL DEFAULT 0 CHECK(manual_protection IN (0,1)),protection_decision_id TEXT,
 PRIMARY KEY(owner_id,id),FOREIGN KEY(owner_id) REFERENCES owner(owner_id),FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id),
 FOREIGN KEY(owner_id,id,current_version_no) REFERENCES memory_version(owner_id,memory_id,version_no) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,protection_decision_id) REFERENCES memory_decision(owner_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((scope_kind='self' AND contact_id IS NULL) OR (scope_kind='contact' AND contact_id IS NOT NULL)),CHECK(state<>'active' OR current_version_no IS NOT NULL)
) STRICT;
CREATE TABLE memory_decision (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,request_key TEXT NOT NULL,request_seal TEXT,action TEXT NOT NULL CHECK(action IN ('accept','edit_accept','reject','auto_accept','auto_update','correct','change','restore','withdraw','protect','unprotect','manual')),
 actor_kind TEXT NOT NULL CHECK(actor_kind IN ('user','system')),execution_id TEXT,target_memory_id TEXT,expected_version_no INTEGER,expected_head_revision INTEGER,restored_from_version_no INTEGER,
 created_at INTEGER NOT NULL,outcome TEXT NOT NULL CHECK(outcome IN ('applied','redacted')),PRIMARY KEY(owner_id,id),UNIQUE(owner_id,request_key),
 FOREIGN KEY(owner_id,execution_id) REFERENCES step_attempt(owner_id,id),FOREIGN KEY(owner_id,target_memory_id) REFERENCES memory(owner_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,target_memory_id,expected_version_no) REFERENCES memory_version(owner_id,memory_id,version_no) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,target_memory_id,restored_from_version_no) REFERENCES memory_version(owner_id,memory_id,version_no) DEFERRABLE INITIALLY DEFERRED,
 CHECK((actor_kind='system' AND action IN ('auto_accept','auto_update') AND (execution_id IS NOT NULL OR outcome='redacted')) OR (actor_kind='user' AND action NOT IN ('auto_accept','auto_update') AND execution_id IS NULL)),
 CHECK((expected_version_no IS NULL)=(expected_head_revision IS NULL)),
 CHECK(action NOT IN ('auto_update','correct','change','restore','withdraw','protect','unprotect') OR (target_memory_id IS NOT NULL AND expected_version_no IS NOT NULL)),
 CHECK((action='restore')=(restored_from_version_no IS NOT NULL))
) STRICT;
CREATE TABLE memory_version (
 owner_id TEXT NOT NULL,memory_id TEXT NOT NULL,version_no INTEGER NOT NULL CHECK(version_no>0),body TEXT,
 formation_kind TEXT NOT NULL CHECK(formation_kind IN ('adoption','correction','change','restore','manual')),adoption_mode TEXT NOT NULL CHECK(adoption_mode IN ('user','auto','manual')),
 decision_id TEXT NOT NULL,previous_version_no INTEGER,restored_from_version_no INTEGER,protection_at_formation INTEGER NOT NULL CHECK(protection_at_formation IN (0,1)),
 content_state TEXT NOT NULL CHECK(content_state IN ('present','redacted')),provenance_state TEXT NOT NULL CHECK(provenance_state IN ('eligible','pending_revalidation','invalidated')),
 PRIMARY KEY(owner_id,memory_id,version_no),UNIQUE(owner_id,decision_id),
 FOREIGN KEY(owner_id,memory_id) REFERENCES memory(owner_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,decision_id) REFERENCES memory_decision(owner_id,id),
 FOREIGN KEY(owner_id,memory_id,previous_version_no) REFERENCES memory_version(owner_id,memory_id,version_no) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,memory_id,restored_from_version_no) REFERENCES memory_version(owner_id,memory_id,version_no) DEFERRABLE INITIALLY DEFERRED,
 CHECK((version_no=1 AND previous_version_no IS NULL) OR (version_no>1 AND previous_version_no IS NOT NULL AND previous_version_no<version_no)),
 CHECK((content_state='present' AND body IS NOT NULL) OR (content_state='redacted' AND body IS NULL)),CHECK((formation_kind='restore')=(restored_from_version_no IS NOT NULL))
) STRICT;
CREATE TABLE decision_candidate (
 owner_id TEXT NOT NULL,decision_id TEXT NOT NULL,candidate_id TEXT NOT NULL,relation_kind TEXT NOT NULL CHECK(relation_kind IN ('accepted','rejected')),accepted_state_revision INTEGER NOT NULL,
 PRIMARY KEY(owner_id,decision_id,candidate_id),FOREIGN KEY(owner_id,decision_id) REFERENCES memory_decision(owner_id,id),FOREIGN KEY(owner_id,candidate_id) REFERENCES memory_candidate(owner_id,id)
) STRICT;
CREATE UNIQUE INDEX memory_candidate_one_consumption ON decision_candidate(owner_id,candidate_id);
CREATE TRIGGER decision_candidate_scope BEFORE INSERT ON decision_candidate WHEN NOT EXISTS(
 SELECT 1 FROM memory_candidate c JOIN memory_decision d ON d.owner_id=c.owner_id AND d.id=NEW.decision_id
 LEFT JOIN memory m ON m.owner_id=d.owner_id AND m.id=d.target_memory_id
 WHERE c.owner_id=NEW.owner_id AND c.id=NEW.candidate_id AND c.state='pending' AND c.state_revision=NEW.accepted_state_revision
 AND ((NEW.relation_kind='rejected' AND d.action='reject') OR (NEW.relation_kind='accepted' AND d.action IN ('accept','edit_accept','auto_accept','auto_update') AND m.scope_kind=c.scope_kind AND m.contact_id IS c.contact_id)))
 BEGIN SELECT RAISE(ABORT,'memory_decision_candidate_mismatch'); END;
CREATE TABLE memory_required_message (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,candidate_id TEXT,memory_id TEXT,version_no INTEGER,source_contact_id TEXT NOT NULL,message_id TEXT NOT NULL,
 PRIMARY KEY(owner_id,id),FOREIGN KEY(owner_id,candidate_id) REFERENCES memory_candidate(owner_id,id),FOREIGN KEY(owner_id,memory_id,version_no) REFERENCES memory_version(owner_id,memory_id,version_no),
 FOREIGN KEY(owner_id,source_contact_id,message_id) REFERENCES message(owner_id,contact_id,id),
 CHECK((candidate_id IS NOT NULL AND memory_id IS NULL AND version_no IS NULL) OR (candidate_id IS NULL AND memory_id IS NOT NULL AND version_no IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX memory_required_candidate ON memory_required_message(owner_id,candidate_id,message_id) WHERE candidate_id IS NOT NULL;
CREATE UNIQUE INDEX memory_required_version ON memory_required_message(owner_id,memory_id,version_no,message_id) WHERE memory_id IS NOT NULL;
CREATE TABLE memory_citation (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,candidate_id TEXT,memory_id TEXT,version_no INTEGER,source_contact_id TEXT NOT NULL,message_id TEXT NOT NULL,record_id TEXT NOT NULL,
 accepted_revision INTEGER NOT NULL,span_start INTEGER NOT NULL,span_end INTEGER NOT NULL,explanation TEXT,
 PRIMARY KEY(owner_id,id),FOREIGN KEY(owner_id,candidate_id) REFERENCES memory_candidate(owner_id,id),FOREIGN KEY(owner_id,memory_id,version_no) REFERENCES memory_version(owner_id,memory_id,version_no),
 FOREIGN KEY(owner_id,source_contact_id,record_id,message_id) REFERENCES capture_record(owner_id,contact_id,id,message_id),CHECK(span_start>=0 AND span_end>span_start),
 CHECK((candidate_id IS NOT NULL AND memory_id IS NULL AND version_no IS NULL) OR (candidate_id IS NULL AND memory_id IS NOT NULL AND version_no IS NOT NULL))
) STRICT;
CREATE TRIGGER memory_required_scope BEFORE INSERT ON memory_required_message WHEN NOT EXISTS(
 SELECT 1 FROM (SELECT scope_kind,contact_id FROM memory_candidate WHERE owner_id=NEW.owner_id AND id=NEW.candidate_id
 UNION ALL SELECT scope_kind,contact_id FROM memory WHERE owner_id=NEW.owner_id AND id=NEW.memory_id) p
 WHERE p.scope_kind='self' OR p.contact_id=NEW.source_contact_id)
 BEGIN SELECT RAISE(ABORT,'memory_source_scope_mismatch'); END;
CREATE TRIGGER memory_citation_scope BEFORE INSERT ON memory_citation WHEN NOT EXISTS(
 SELECT 1 FROM memory_required_message r WHERE r.owner_id=NEW.owner_id AND r.candidate_id IS NEW.candidate_id
 AND r.memory_id IS NEW.memory_id AND r.version_no IS NEW.version_no AND r.source_contact_id=NEW.source_contact_id AND r.message_id=NEW.message_id)
 BEGIN SELECT RAISE(ABORT,'memory_citation_required_mismatch'); END;
CREATE INDEX memory_version_previous ON memory_version(owner_id,memory_id,previous_version_no);
CREATE INDEX memory_version_restored ON memory_version(owner_id,memory_id,restored_from_version_no);
CREATE INDEX memory_scope ON memory(owner_id,scope_kind,contact_id,state);
CREATE INDEX candidate_scope ON memory_candidate(owner_id,scope_kind,contact_id,state);
CREATE INDEX candidate_producer ON memory_candidate(owner_id,produced_attempt_id);
CREATE INDEX memory_required_source ON memory_required_message(owner_id,source_contact_id,message_id);
CREATE INDEX memory_citation_source ON memory_citation(owner_id,source_contact_id,record_id);
CREATE INDEX memory_citation_version ON memory_citation(owner_id,memory_id,version_no);
CREATE INDEX memory_citation_candidate ON memory_citation(owner_id,candidate_id);
CREATE INDEX memory_decision_target ON memory_decision(owner_id,target_memory_id);
CREATE INDEX memory_decision_execution ON memory_decision(owner_id,execution_id);
CREATE INDEX decision_candidate_reverse ON decision_candidate(owner_id,candidate_id);
CREATE TRIGGER memory_candidate_fixed BEFORE UPDATE OF proposed_body,produced_attempt_id,event_id,output_no,scope_kind,contact_id ON memory_candidate
 WHEN NOT (NEW.state='deleted' AND NEW.proposed_body IS NULL AND NEW.produced_attempt_id IS NULL AND NEW.event_id IS NULL)
 BEGIN SELECT RAISE(ABORT,'memory_candidate_immutable'); END;
CREATE TRIGGER memory_version_fixed BEFORE UPDATE ON memory_version
 WHEN NOT (OLD.content_state='present' AND NEW.content_state='redacted' AND NEW.body IS NULL AND NEW.provenance_state='invalidated'
 AND NEW.owner_id=OLD.owner_id AND NEW.memory_id=OLD.memory_id AND NEW.version_no=OLD.version_no AND NEW.decision_id=OLD.decision_id
 AND NEW.formation_kind=OLD.formation_kind AND NEW.adoption_mode=OLD.adoption_mode AND NEW.previous_version_no IS OLD.previous_version_no
 AND NEW.restored_from_version_no IS OLD.restored_from_version_no AND NEW.protection_at_formation=OLD.protection_at_formation)
 BEGIN SELECT RAISE(ABORT,'memory_version_immutable'); END;
CREATE TRIGGER memory_version_decision BEFORE INSERT ON memory_version WHEN NOT EXISTS(
 SELECT 1 FROM memory_decision d JOIN memory m ON m.owner_id=d.owner_id AND m.id=d.target_memory_id
 WHERE d.owner_id=NEW.owner_id AND d.id=NEW.decision_id AND d.target_memory_id=NEW.memory_id AND d.outcome='applied'
 AND d.action NOT IN ('reject','withdraw','protect','unprotect') AND d.expected_version_no IS NEW.previous_version_no
 AND NEW.version_no=COALESCE(d.expected_version_no,0)+1 AND m.current_version_no IS d.expected_version_no
 AND (d.expected_head_revision IS NULL OR m.head_revision=d.expected_head_revision)
 AND (d.action NOT IN ('auto_accept','auto_update','accept','edit_accept') OR EXISTS(SELECT 1 FROM decision_candidate c WHERE c.owner_id=d.owner_id AND c.decision_id=d.id AND c.relation_kind='accepted'))
 AND d.restored_from_version_no IS NEW.restored_from_version_no
 AND ((d.actor_kind='system' AND NEW.adoption_mode='auto') OR (d.action='restore') OR (d.actor_kind='user' AND NEW.adoption_mode<>'auto')))
 BEGIN SELECT RAISE(ABORT,'memory_version_decision_mismatch'); END;
CREATE TRIGGER memory_head_closure BEFORE UPDATE OF current_version_no ON memory WHEN NEW.current_version_no IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM memory_version v JOIN memory_decision d ON d.owner_id=v.owner_id AND d.id=v.decision_id
 WHERE v.owner_id=NEW.owner_id AND v.memory_id=NEW.id AND v.version_no=NEW.current_version_no AND d.target_memory_id=NEW.id
 AND v.content_state='present' AND v.provenance_state='eligible' AND d.expected_version_no IS OLD.current_version_no
 AND (d.expected_head_revision IS NULL OR d.expected_head_revision=OLD.head_revision)
 AND (v.adoption_mode='manual' OR EXISTS(SELECT 1 FROM memory_required_message r WHERE r.owner_id=v.owner_id AND r.memory_id=v.memory_id AND r.version_no=v.version_no))
 AND NOT EXISTS(SELECT 1 FROM memory_required_message r WHERE r.owner_id=v.owner_id AND r.memory_id=v.memory_id AND r.version_no=v.version_no
 AND NOT EXISTS(SELECT 1 FROM memory_citation c WHERE c.owner_id=r.owner_id AND c.memory_id=r.memory_id AND c.version_no=r.version_no AND c.message_id=r.message_id)))
 BEGIN SELECT RAISE(ABORT,'memory_head_incomplete'); END;
`});
