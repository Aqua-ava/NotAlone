import {memoryExtractionMigration} from '../../../memory/sqlite/schema.ts';
import type {StorageMigration} from '../../../storage/sqlite/contracts.ts';
/** 集成方分配版本；已发布迁移保持不变。 */
export const replyCandidateMigration=(version:number):StorageMigration=>({version,sql:`
CREATE TABLE reply_candidate (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,request_id TEXT NOT NULL,candidate_no INTEGER NOT NULL CHECK(candidate_no>=1),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,request_id,candidate_no),UNIQUE(owner_id,request_id,id),
 FOREIGN KEY(owner_id,request_id) REFERENCES reply_request(owner_id,id)
) STRICT;
CREATE TABLE reply_candidate_version (
 owner_id TEXT NOT NULL,candidate_id TEXT NOT NULL,version_no INTEGER NOT NULL CHECK(version_no>=1),
 origin_kind TEXT NOT NULL CHECK(origin_kind IN ('model','manual')),parent_version_no INTEGER,call_id TEXT,output_no INTEGER,
 content_state TEXT NOT NULL CHECK(content_state IN ('available','cleared')),part_count INTEGER NOT NULL CHECK(part_count BETWEEN 1 AND 8),
 PRIMARY KEY(owner_id,candidate_id,version_no),UNIQUE(owner_id,call_id,output_no),
 FOREIGN KEY(owner_id,candidate_id) REFERENCES reply_candidate(owner_id,id),
 FOREIGN KEY(owner_id,candidate_id,parent_version_no) REFERENCES reply_candidate_version(owner_id,candidate_id,version_no),
 FOREIGN KEY(owner_id,call_id) REFERENCES model_call(owner_id,id),
 CHECK((origin_kind='model' AND version_no=1 AND parent_version_no IS NULL AND (content_state='cleared' OR (call_id IS NOT NULL AND output_no>=1)))
 OR (origin_kind='manual' AND version_no>1 AND parent_version_no>=1 AND parent_version_no<version_no AND call_id IS NULL AND output_no IS NULL))
) STRICT;
CREATE TRIGGER reply_version_clear_only BEFORE UPDATE ON reply_candidate_version
 WHEN NOT (OLD.content_state='available' AND NEW.content_state='cleared' AND NEW.call_id IS NULL AND NEW.output_no IS NULL
 AND OLD.owner_id=NEW.owner_id AND OLD.candidate_id=NEW.candidate_id AND OLD.version_no=NEW.version_no
 AND OLD.origin_kind=NEW.origin_kind AND OLD.parent_version_no IS NEW.parent_version_no AND OLD.part_count=NEW.part_count)
 BEGIN SELECT RAISE(ABORT,'reply_version_immutable'); END;
CREATE TRIGGER reply_version_call BEFORE INSERT ON reply_candidate_version WHEN NEW.origin_kind='model' AND NOT EXISTS(
 SELECT 1 FROM reply_candidate k JOIN reply_attempt a ON a.owner_id=k.owner_id AND a.request_id=k.request_id
 JOIN model_call c ON c.owner_id=a.owner_id AND c.reply_attempt_id=a.id JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id
 WHERE k.owner_id=NEW.owner_id AND k.id=NEW.candidate_id AND c.id=NEW.call_id AND c.state='succeeded' AND o.reply_request_id=k.request_id)
 BEGIN SELECT RAISE(ABORT,'reply_version_call_scope'); END;
CREATE TABLE reply_version_part (
 owner_id TEXT NOT NULL,candidate_id TEXT NOT NULL,version_no INTEGER NOT NULL,part_no INTEGER NOT NULL CHECK(part_no>=1),text_body TEXT NOT NULL CHECK(length(text_body)>0),
 PRIMARY KEY(owner_id,candidate_id,version_no,part_no),
 FOREIGN KEY(owner_id,candidate_id,version_no) REFERENCES reply_candidate_version(owner_id,candidate_id,version_no)
) STRICT;
CREATE TRIGGER reply_part_immutable BEFORE UPDATE ON reply_version_part BEGIN SELECT RAISE(ABORT,'reply_part_immutable'); END;
CREATE TABLE reply_selection (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,request_id TEXT NOT NULL,selection_no INTEGER NOT NULL CHECK(selection_no>=1),candidate_id TEXT NOT NULL,version_no INTEGER NOT NULL,selected_at INTEGER NOT NULL,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,request_id,selection_no),
 FOREIGN KEY(owner_id,request_id,candidate_id) REFERENCES reply_candidate(owner_id,request_id,id),
 FOREIGN KEY(owner_id,candidate_id,version_no) REFERENCES reply_candidate_version(owner_id,candidate_id,version_no)
) STRICT;
CREATE TRIGGER reply_selection_immutable BEFORE UPDATE ON reply_selection BEGIN SELECT RAISE(ABORT,'reply_selection_immutable'); END;
CREATE TABLE reply_candidate_request (
 owner_id TEXT NOT NULL,request_id TEXT NOT NULL,coverage_json TEXT NOT NULL CHECK(json_valid(coverage_json)),
 coverage_warning TEXT,carried_selection_id TEXT,
 PRIMARY KEY(owner_id,request_id),
 FOREIGN KEY(owner_id,request_id) REFERENCES reply_request(owner_id,id),
 FOREIGN KEY(owner_id,carried_selection_id) REFERENCES reply_selection(owner_id,id)
) STRICT;
CREATE TRIGGER reply_candidate_request_immutable BEFORE UPDATE ON reply_candidate_request
BEGIN SELECT RAISE(ABORT,'reply_candidate_request_immutable'); END;
CREATE TABLE reply_candidate_context (
 owner_id TEXT NOT NULL,context_id TEXT NOT NULL,owner_memory_revision INTEGER NOT NULL,contact_memory_revision INTEGER NOT NULL,
 owner_document_revision INTEGER NOT NULL,contact_document_revision INTEGER NOT NULL,
 PRIMARY KEY(owner_id,context_id),FOREIGN KEY(owner_id,context_id) REFERENCES reply_context(owner_id,id)
) STRICT;
CREATE TRIGGER reply_candidate_context_immutable BEFORE UPDATE ON reply_candidate_context BEGIN SELECT RAISE(ABORT,'reply_candidate_context_immutable'); END;
CREATE TABLE reply_candidate_input (
 owner_id TEXT NOT NULL,context_id TEXT NOT NULL,item_no INTEGER NOT NULL CHECK(item_no>=1),kind TEXT NOT NULL CHECK(kind IN ('message','entry','memory','memory_candidate','document','selection','coverage')),
 identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),text_body TEXT NOT NULL,
 PRIMARY KEY(owner_id,context_id,item_no),FOREIGN KEY(owner_id,context_id) REFERENCES reply_context(owner_id,id)
) STRICT;
CREATE TRIGGER reply_input_immutable BEFORE UPDATE ON reply_candidate_input BEGIN SELECT RAISE(ABORT,'reply_input_immutable'); END;
CREATE TABLE reply_candidate_input_source (
 owner_id TEXT NOT NULL,context_id TEXT NOT NULL,item_no INTEGER NOT NULL,source_contact_id TEXT NOT NULL,record_id TEXT NOT NULL,message_id TEXT NOT NULL,accepted_revision INTEGER NOT NULL,
 PRIMARY KEY(owner_id,context_id,item_no,record_id),
 FOREIGN KEY(owner_id,context_id,item_no) REFERENCES reply_candidate_input(owner_id,context_id,item_no),
 FOREIGN KEY(owner_id,source_contact_id,record_id,message_id) REFERENCES capture_record(owner_id,contact_id,id,message_id)
) STRICT;
CREATE TABLE reply_execution_input (
 owner_id TEXT NOT NULL,event_id TEXT NOT NULL,context_id TEXT NOT NULL,item_no INTEGER NOT NULL,
 PRIMARY KEY(owner_id,event_id,context_id,item_no),
 FOREIGN KEY(owner_id,event_id) REFERENCES execution_event(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,context_id,item_no) REFERENCES reply_candidate_input(owner_id,context_id,item_no)
) STRICT;
CREATE TRIGGER reply_execution_input_scope BEFORE INSERT ON reply_execution_input WHEN NOT EXISTS(
 SELECT 1 FROM execution_event e JOIN model_call c ON c.owner_id=e.owner_id AND c.id=e.originated_call_id
 WHERE e.owner_id=NEW.owner_id AND e.id=NEW.event_id AND c.reply_context_id=NEW.context_id AND e.reply_attempt_id=c.reply_attempt_id)
 BEGIN SELECT RAISE(ABORT,'reply_execution_input_scope'); END;
DROP TRIGGER event_source_planned;
${memoryExtractionMigration(8).sql.match(/CREATE TRIGGER event_source_planned[\s\S]*?END;/)![0].replace("AND es.source_contact_id=NEW.source_contact_id)",`AND es.source_contact_id=NEW.source_contact_id
 UNION ALL SELECT 1 FROM reply_execution_input x JOIN reply_candidate_input_source s ON s.owner_id=x.owner_id AND s.context_id=x.context_id AND s.item_no=x.item_no
 WHERE x.owner_id=NEW.owner_id AND x.event_id=NEW.event_id AND s.record_id=NEW.record_id AND s.source_contact_id=NEW.source_contact_id)`)}
CREATE TABLE reply_basis (
 owner_id TEXT NOT NULL,candidate_id TEXT NOT NULL,version_no INTEGER NOT NULL,basis_no INTEGER NOT NULL CHECK(basis_no>=1),context_id TEXT NOT NULL,item_no INTEGER NOT NULL,
 verification_state TEXT NOT NULL CHECK(verification_state IN ('actual_input','inherited_unverified')),
 PRIMARY KEY(owner_id,candidate_id,version_no,basis_no),
 FOREIGN KEY(owner_id,candidate_id,version_no) REFERENCES reply_candidate_version(owner_id,candidate_id,version_no),
 FOREIGN KEY(owner_id,context_id,item_no) REFERENCES reply_candidate_input(owner_id,context_id,item_no)
) STRICT;
CREATE TRIGGER reply_basis_immutable BEFORE UPDATE ON reply_basis BEGIN SELECT RAISE(ABORT,'reply_basis_immutable'); END;
`});
