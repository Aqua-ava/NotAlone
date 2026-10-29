import type {StorageMigration} from '../../storage/sqlite/contracts.ts';
/** 版本由集成方分配；讨论控制与受管运行副本分开保存。 */
export const discussionMigration=(version:number):StorageMigration=>({version,sql:`
CREATE TABLE assistant_discussion (
 owner_id TEXT NOT NULL, id TEXT NOT NULL, contact_id TEXT NOT NULL, title TEXT,
 state TEXT NOT NULL CHECK(state IN ('active','deleting','deleted')),
 current_runtime_id TEXT, generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
 is_current INTEGER NOT NULL DEFAULT 0 CHECK(is_current IN (0,1)),
 created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
 PRIMARY KEY(owner_id,id), UNIQUE(owner_id,contact_id,id),
 FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id),
 FOREIGN KEY(owner_id,contact_id,id,current_runtime_id) REFERENCES runtime_copy(owner_id,contact_id,discussion_id,id)
) STRICT;
CREATE UNIQUE INDEX discussion_current_contact ON assistant_discussion(owner_id,contact_id) WHERE is_current=1 AND state='active';
CREATE TRIGGER discussion_scope_immutable BEFORE UPDATE OF owner_id,id,contact_id ON assistant_discussion
BEGIN SELECT RAISE(ABORT,'discussion_scope_immutable'); END;
CREATE UNIQUE INDEX discussion_confirmation_scope ON manual_confirmation(owner_id,contact_id,id);
CREATE TABLE reply_request (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,contact_id TEXT NOT NULL,discussion_id TEXT NOT NULL,
 request_key TEXT NOT NULL,trigger_entry_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('discussion','reply')),
 identity_origin TEXT NOT NULL CHECK(identity_origin IN ('manual','binding')),binding_id TEXT,verification_id TEXT,confirmation_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('accepted','running','committed','cancelled','invalidated')),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,discussion_id,request_key),UNIQUE(owner_id,request_key),UNIQUE(owner_id,contact_id,discussion_id,id),
 FOREIGN KEY(owner_id,contact_id,discussion_id) REFERENCES assistant_discussion(owner_id,contact_id,id),
 FOREIGN KEY(owner_id,contact_id,discussion_id,trigger_entry_id) REFERENCES discussion_entry(owner_id,contact_id,discussion_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,contact_id,binding_id) REFERENCES conversation_binding(owner_id,contact_id,id),
 FOREIGN KEY(owner_id,binding_id,verification_id) REFERENCES binding_verification(owner_id,binding_id,id),
 FOREIGN KEY(owner_id,contact_id,confirmation_id) REFERENCES manual_confirmation(owner_id,contact_id,id),
 CHECK((identity_origin='manual' AND confirmation_id IS NOT NULL AND binding_id IS NULL AND verification_id IS NULL)
 OR (identity_origin='binding' AND binding_id IS NOT NULL AND verification_id IS NOT NULL AND confirmation_id IS NULL))
) STRICT;
CREATE TRIGGER reply_request_scope_immutable BEFORE UPDATE OF owner_id,id,contact_id,discussion_id,request_key,trigger_entry_id,kind,identity_origin,binding_id,verification_id,confirmation_id ON reply_request
BEGIN SELECT RAISE(ABORT,'reply_request_scope_immutable'); END;
CREATE TABLE reply_attempt (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,request_id TEXT NOT NULL,attempt_no INTEGER NOT NULL CHECK(attempt_no>=1),
 state TEXT NOT NULL CHECK(state IN ('running','committed','cancelled','failed','invalidated')),
 lease_token TEXT NOT NULL,accepted_data_generation INTEGER NOT NULL,accepted_discussion_generation INTEGER NOT NULL,
 accepted_source_revision INTEGER NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,error_code TEXT,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,request_id,attempt_no),UNIQUE(owner_id,request_id,id),
 FOREIGN KEY(owner_id,request_id) REFERENCES reply_request(owner_id,id)
) STRICT;
CREATE UNIQUE INDEX reply_one_live_attempt ON reply_attempt(owner_id,request_id) WHERE state='running';
CREATE TABLE reply_context (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,contact_id TEXT NOT NULL,discussion_id TEXT NOT NULL,
 origin_kind TEXT NOT NULL CHECK(origin_kind IN ('request','rebuild')),attempt_id TEXT,request_id TEXT,
 preference_revision INTEGER NOT NULL,skill_revision INTEGER NOT NULL,owner_memory_revision INTEGER NOT NULL,contact_memory_revision INTEGER NOT NULL,
 skill_run_json TEXT NOT NULL CHECK(json_valid(skill_run_json)),frozen_at INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','invalidated')),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,contact_id,discussion_id,id),UNIQUE(owner_id,attempt_id,id),
 FOREIGN KEY(owner_id,contact_id,discussion_id) REFERENCES assistant_discussion(owner_id,contact_id,id),
 FOREIGN KEY(owner_id,contact_id,discussion_id,request_id) REFERENCES reply_request(owner_id,contact_id,discussion_id,id),
 FOREIGN KEY(owner_id,request_id,attempt_id) REFERENCES reply_attempt(owner_id,request_id,id),
 CHECK((origin_kind='request' AND attempt_id IS NOT NULL AND request_id IS NOT NULL) OR (origin_kind='rebuild' AND attempt_id IS NULL AND request_id IS NULL))
) STRICT;
CREATE TRIGGER reply_context_immutable BEFORE UPDATE OF owner_id,id,contact_id,discussion_id,origin_kind,attempt_id,request_id,preference_revision,skill_revision,owner_memory_revision,contact_memory_revision,skill_run_json,frozen_at ON reply_context
BEGIN SELECT RAISE(ABORT,'reply_context_immutable'); END;
CREATE TABLE reply_context_item (
 owner_id TEXT NOT NULL,context_id TEXT NOT NULL,item_no INTEGER NOT NULL CHECK(item_no>=1),
 kind TEXT NOT NULL CHECK(kind IN ('message','entry','skill')),role TEXT NOT NULL,presentation_no INTEGER NOT NULL,
 source_contact_id TEXT,message_id TEXT,record_id TEXT,accepted_revision INTEGER,entry_id TEXT,package_id TEXT,package_revision_no INTEGER,
 PRIMARY KEY(owner_id,context_id,item_no),
 FOREIGN KEY(owner_id,context_id) REFERENCES reply_context(owner_id,id),
 FOREIGN KEY(owner_id,source_contact_id,record_id,message_id) REFERENCES capture_record(owner_id,contact_id,id,message_id),
 FOREIGN KEY(owner_id,entry_id) REFERENCES discussion_entry(owner_id,id),
 FOREIGN KEY(owner_id,package_id,package_revision_no) REFERENCES skill_package_revision(owner_id,package_id,revision_no),
 CHECK((kind='message' AND source_contact_id IS NOT NULL AND message_id IS NOT NULL AND record_id IS NOT NULL AND accepted_revision IS NOT NULL AND entry_id IS NULL AND package_id IS NULL AND package_revision_no IS NULL)
 OR (kind='entry' AND entry_id IS NOT NULL AND source_contact_id IS NULL AND message_id IS NULL AND record_id IS NULL AND accepted_revision IS NULL AND package_id IS NULL AND package_revision_no IS NULL)
 OR (kind='skill' AND package_id IS NOT NULL AND package_revision_no IS NOT NULL AND source_contact_id IS NULL AND message_id IS NULL AND record_id IS NULL AND accepted_revision IS NULL AND entry_id IS NULL))
) STRICT;
CREATE TRIGGER reply_context_item_immutable BEFORE UPDATE ON reply_context_item
BEGIN SELECT RAISE(ABORT,'reply_context_item_immutable'); END;
CREATE TRIGGER reply_context_item_scope BEFORE INSERT ON reply_context_item WHEN
 (NEW.kind='message' AND NOT EXISTS(SELECT 1 FROM reply_context c WHERE c.owner_id=NEW.owner_id AND c.id=NEW.context_id AND c.contact_id=NEW.source_contact_id))
 OR (NEW.kind='entry' AND NOT EXISTS(SELECT 1 FROM reply_context c JOIN discussion_entry e ON e.owner_id=c.owner_id AND e.contact_id=c.contact_id AND e.discussion_id=c.discussion_id WHERE c.owner_id=NEW.owner_id AND c.id=NEW.context_id AND e.id=NEW.entry_id))
BEGIN SELECT RAISE(ABORT,'reply_context_scope'); END;
CREATE TABLE discussion_entry (
 owner_id TEXT NOT NULL, id TEXT NOT NULL, contact_id TEXT NOT NULL, discussion_id TEXT NOT NULL,
 position INTEGER NOT NULL CHECK(position>=1),role TEXT NOT NULL CHECK(role IN ('user','assistant')),
 body TEXT, origin_request_id TEXT NOT NULL, origin_call_id TEXT, origin_event_id TEXT,
 content_state TEXT NOT NULL CHECK(content_state IN ('available','cleared')),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,discussion_id,position),UNIQUE(owner_id,contact_id,discussion_id,id),
 FOREIGN KEY(owner_id,contact_id,discussion_id) REFERENCES assistant_discussion(owner_id,contact_id,id),
 FOREIGN KEY(owner_id,origin_request_id) REFERENCES reply_request(owner_id,id),
 FOREIGN KEY(owner_id,origin_call_id) REFERENCES model_call(owner_id,id),
 FOREIGN KEY(owner_id,origin_event_id) REFERENCES execution_event(owner_id,id),
 CHECK((role='user' AND origin_call_id IS NULL AND origin_event_id IS NULL) OR (role='assistant' AND ((content_state='available' AND origin_call_id IS NOT NULL AND origin_event_id IS NOT NULL) OR (content_state='cleared' AND origin_call_id IS NULL AND origin_event_id IS NULL)))),
 CHECK((content_state='available' AND body IS NOT NULL) OR (content_state='cleared' AND body IS NULL))
) STRICT;
CREATE TRIGGER discussion_entry_immutable BEFORE UPDATE OF owner_id,id,contact_id,discussion_id,position,role,origin_request_id ON discussion_entry
BEGIN SELECT RAISE(ABORT,'discussion_entry_immutable'); END;
CREATE TRIGGER discussion_entry_clear_only BEFORE UPDATE OF body,content_state,origin_call_id,origin_event_id ON discussion_entry
WHEN NOT (OLD.content_state='available' AND NEW.content_state='cleared' AND NEW.body IS NULL AND NEW.origin_call_id IS NULL AND NEW.origin_event_id IS NULL)
BEGIN SELECT RAISE(ABORT,'discussion_entry_clear_only'); END;
CREATE TRIGGER discussion_entry_request BEFORE INSERT ON discussion_entry WHEN NOT EXISTS(
 SELECT 1 FROM reply_request r WHERE r.owner_id=NEW.owner_id AND r.contact_id=NEW.contact_id AND r.discussion_id=NEW.discussion_id AND r.id=NEW.origin_request_id
 AND ((NEW.role='assistant' AND r.trigger_entry_id<>NEW.id) OR (NEW.role='user' AND r.trigger_entry_id=NEW.id)))
BEGIN SELECT RAISE(ABORT,'discussion_entry_request'); END;
CREATE TRIGGER discussion_entry_call BEFORE INSERT ON discussion_entry WHEN NEW.role='assistant' AND NOT EXISTS(
 SELECT 1 FROM model_call c JOIN reply_attempt a ON a.owner_id=c.owner_id AND a.id=c.reply_attempt_id
 JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id
 JOIN execution_event e ON e.owner_id=c.owner_id AND e.id=NEW.origin_event_id AND e.originated_call_id=c.id AND e.reply_attempt_id=a.id
 WHERE c.owner_id=NEW.owner_id AND c.id=NEW.origin_call_id AND c.state='succeeded' AND a.request_id=NEW.origin_request_id
 AND o.reply_request_id=a.request_id AND e.kind='assistant_message' AND json_extract(e.payload,'$.text')=NEW.body)
BEGIN SELECT RAISE(ABORT,'discussion_entry_call'); END;
CREATE TABLE runtime_copy (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,contact_id TEXT NOT NULL,discussion_id TEXT NOT NULL,
 sdk_instance_id TEXT NOT NULL UNIQUE,managed_locator TEXT NOT NULL UNIQUE,
 address_json TEXT CHECK(address_json IS NULL OR json_valid(address_json)),
 write_generation INTEGER NOT NULL CHECK(write_generation>=0),accepted_data_generation INTEGER NOT NULL,source_revision INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('preparing','dirty','ready','blocked','deleting','deleted')),
 committed_request_id TEXT,committed_event_boundary TEXT,configuration_digest TEXT,
 cleanup_operation_id TEXT,manifest_complete INTEGER NOT NULL DEFAULT 0 CHECK(manifest_complete IN (0,1)),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,contact_id,discussion_id,id),
 FOREIGN KEY(owner_id,contact_id,discussion_id) REFERENCES assistant_discussion(owner_id,contact_id,id),
 FOREIGN KEY(owner_id,committed_request_id) REFERENCES reply_request(owner_id,id),
 CHECK(state NOT IN ('dirty','ready') OR address_json IS NOT NULL),
 CHECK(state<>'ready' OR (committed_request_id IS NOT NULL AND committed_event_boundary IS NOT NULL AND configuration_digest IS NOT NULL)),
 CHECK(state<>'deleted' OR address_json IS NULL)
) STRICT;
CREATE TRIGGER runtime_scope_immutable BEFORE UPDATE OF owner_id,id,contact_id,discussion_id,sdk_instance_id,managed_locator,write_generation,accepted_data_generation,source_revision ON runtime_copy
BEGIN SELECT RAISE(ABORT,'runtime_scope_immutable'); END;
CREATE TABLE runtime_file (
 owner_id TEXT NOT NULL,copy_id TEXT NOT NULL,file_id TEXT NOT NULL,address_json TEXT NOT NULL CHECK(json_valid(address_json)),cleared INTEGER NOT NULL DEFAULT 0 CHECK(cleared IN (0,1)),
 PRIMARY KEY(owner_id,file_id),UNIQUE(owner_id,copy_id,address_json),
 FOREIGN KEY(owner_id,copy_id) REFERENCES runtime_copy(owner_id,id)
) STRICT;
CREATE TABLE runtime_context (
 owner_id TEXT NOT NULL,copy_id TEXT NOT NULL,incorporation_no INTEGER NOT NULL CHECK(incorporation_no>=1),context_id TEXT NOT NULL,
 event_start INTEGER,event_end INTEGER,provenance_state TEXT NOT NULL CHECK(provenance_state IN ('verified','invalidated')),
 PRIMARY KEY(owner_id,copy_id,incorporation_no),
 FOREIGN KEY(owner_id,copy_id) REFERENCES runtime_copy(owner_id,id),
 FOREIGN KEY(owner_id,context_id) REFERENCES reply_context(owner_id,id),
 CHECK((event_start IS NULL AND event_end IS NULL) OR (event_start>=0 AND event_end>=event_start))
) STRICT;
CREATE TRIGGER runtime_context_scope BEFORE INSERT ON runtime_context WHEN NOT EXISTS(
 SELECT 1 FROM runtime_copy r JOIN reply_context c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.discussion_id=r.discussion_id
 WHERE r.owner_id=NEW.owner_id AND r.id=NEW.copy_id AND c.id=NEW.context_id)
BEGIN SELECT RAISE(ABORT,'runtime_context_scope'); END;
CREATE TRIGGER runtime_commit_request BEFORE UPDATE OF committed_request_id ON runtime_copy WHEN NEW.committed_request_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM reply_request r WHERE r.owner_id=NEW.owner_id AND r.contact_id=NEW.contact_id AND r.discussion_id=NEW.discussion_id AND r.id=NEW.committed_request_id)
BEGIN SELECT RAISE(ABORT,'runtime_commit_request'); END;
CREATE INDEX runtime_discussion ON runtime_copy(owner_id,contact_id,discussion_id);
CREATE INDEX runtime_context_origin ON runtime_context(owner_id,context_id);
`});
