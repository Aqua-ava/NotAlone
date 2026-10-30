import type { StorageMigration } from '../../storage/sqlite/contracts.ts';
export const historyMigration = (version:number):StorageMigration => ({version,sql:`
CREATE TABLE history_deletion_fence (
 owner_id TEXT NOT NULL,contact_id TEXT NOT NULL,operation_id TEXT NOT NULL,
 PRIMARY KEY(owner_id,contact_id),FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id)
) STRICT;
CREATE TABLE history_source_exclusion (
 owner_id TEXT NOT NULL,conversation_id TEXT NOT NULL,scheme TEXT NOT NULL CHECK(scheme IN ('local','server')),external_key TEXT NOT NULL,operation_id TEXT NOT NULL,
 PRIMARY KEY(owner_id,conversation_id,scheme,external_key),
 FOREIGN KEY(owner_id,conversation_id) REFERENCES channel_conversation(owner_id,id)
) STRICT;
CREATE TABLE read_goal (
 owner_id TEXT NOT NULL, id TEXT NOT NULL, contact_id TEXT NOT NULL, binding_id TEXT NOT NULL, grant_id TEXT NOT NULL,
 accepted_data_generation INTEGER NOT NULL, accepted_barrier_generation INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('history','incremental')), target_protocol TEXT NOT NULL, target_descriptor TEXT NOT NULL,
 target_json TEXT NOT NULL, eligibility_json TEXT NOT NULL, support_json TEXT NOT NULL, cursor TEXT,
 state TEXT NOT NULL CHECK(state IN ('running','complete','incomplete','invalidated')), coverage_state TEXT NOT NULL,
 completed_partitions TEXT NOT NULL DEFAULT '[]', failure_code TEXT, created_at INTEGER NOT NULL,
 PRIMARY KEY(owner_id,id), UNIQUE(owner_id,contact_id,id),
 FOREIGN KEY(owner_id,contact_id,binding_id) REFERENCES conversation_binding(owner_id,contact_id,id),
 FOREIGN KEY(owner_id,contact_id,binding_id,grant_id) REFERENCES read_grant(owner_id,contact_id,binding_id,id)
) STRICT;
CREATE TABLE sync_capture (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,contact_id TEXT NOT NULL,goal_id TEXT NOT NULL,
 read_epoch INTEGER NOT NULL,runtime_token TEXT NOT NULL,captured_at INTEGER NOT NULL,adapter_version TEXT NOT NULL,
 cursor_in TEXT,cursor_out TEXT,state TEXT NOT NULL CHECK(state IN ('accepted','quarantined')),error_code TEXT,
 response_digest TEXT NOT NULL, PRIMARY KEY(owner_id,id), UNIQUE(owner_id,contact_id,id),
 FOREIGN KEY(owner_id,contact_id,goal_id) REFERENCES read_goal(owner_id,contact_id,id)
) STRICT;
CREATE TABLE message (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,contact_id TEXT NOT NULL,binding_id TEXT NOT NULL,
 identity_scheme TEXT NOT NULL,external_key TEXT NOT NULL,sender_role TEXT NOT NULL CHECK(sender_role IN ('owner','contact')),
 kind TEXT NOT NULL CHECK(kind IN ('text','image','voice','video','file','sticker','other')),text_body TEXT,original_type TEXT NOT NULL,
 sent_at INTEGER,time_precision TEXT CHECK(time_precision IN ('second','millisecond')),order_scheme TEXT,order_key TEXT,
 interpretation_revision INTEGER NOT NULL DEFAULT 1,availability TEXT NOT NULL DEFAULT 'available' CHECK(availability IN ('available','deleting')),
 display_no INTEGER NOT NULL UNIQUE,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,contact_id,id),UNIQUE(owner_id,contact_id,binding_id,id),UNIQUE(owner_id,contact_id,binding_id,identity_scheme,external_key),
 FOREIGN KEY(owner_id,contact_id,binding_id) REFERENCES conversation_binding(owner_id,contact_id,id),
 CHECK((kind='text' AND text_body IS NOT NULL) OR (kind<>'text' AND text_body IS NULL)),
 CHECK((sent_at IS NULL)=(time_precision IS NULL)),CHECK((order_scheme IS NULL)=(order_key IS NULL))
) STRICT;
CREATE TABLE message_alias (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,contact_id TEXT NOT NULL,binding_id TEXT NOT NULL,scheme TEXT NOT NULL,external_key TEXT NOT NULL,message_id TEXT NOT NULL,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,contact_id,binding_id,scheme,external_key),
 FOREIGN KEY(owner_id,contact_id,binding_id,message_id) REFERENCES message(owner_id,contact_id,binding_id,id)
) STRICT;
CREATE TABLE capture_record (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,contact_id TEXT NOT NULL,capture_id TEXT NOT NULL,item_no INTEGER NOT NULL CHECK(item_no>=0 AND item_no<1000),
 state TEXT NOT NULL CHECK(state IN ('normalized','quarantined','excluded')),message_id TEXT,raw_payload TEXT,
 observed_scheme TEXT,observed_key TEXT,normalizer_version TEXT NOT NULL,reason_code TEXT,availability TEXT NOT NULL DEFAULT 'available' CHECK(availability IN ('available','deleting')),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,capture_id,item_no),UNIQUE(owner_id,contact_id,id),UNIQUE(owner_id,contact_id,id,message_id),
 FOREIGN KEY(owner_id,contact_id,capture_id) REFERENCES sync_capture(owner_id,contact_id,id),
 FOREIGN KEY(owner_id,contact_id,message_id) REFERENCES message(owner_id,contact_id,id),
 CHECK((state='normalized' AND message_id IS NOT NULL AND reason_code IS NULL) OR (state IN ('quarantined','excluded') AND message_id IS NULL AND reason_code IS NOT NULL))
) STRICT;
CREATE TRIGGER capture_record_immutable BEFORE UPDATE OF owner_id,id,contact_id,capture_id,item_no,state,message_id,raw_payload,observed_scheme,observed_key,normalizer_version,reason_code ON capture_record WHEN OLD.state IN ('normalized','excluded')
 BEGIN SELECT RAISE(ABORT,'capture_record_immutable'); END;
CREATE TRIGGER capture_record_no_restore BEFORE UPDATE OF availability ON capture_record WHEN NEW.availability<>'deleting'
 BEGIN SELECT RAISE(ABORT,'capture_record_no_restore'); END;
CREATE TRIGGER capture_record_binding BEFORE INSERT ON capture_record WHEN NEW.message_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM sync_capture c JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id
 JOIN message m ON m.owner_id=NEW.owner_id AND m.contact_id=NEW.contact_id AND m.id=NEW.message_id
 WHERE c.owner_id=NEW.owner_id AND c.contact_id=NEW.contact_id AND c.id=NEW.capture_id AND m.binding_id=g.binding_id)
 BEGIN SELECT RAISE(ABORT,'capture_record_binding_mismatch'); END;
CREATE INDEX message_contact_display ON message(owner_id,contact_id,display_no);
CREATE INDEX capture_record_message ON capture_record(owner_id,contact_id,message_id);
CREATE INDEX read_goal_contact ON read_goal(owner_id,contact_id,created_at);
CREATE TRIGGER message_immutable BEFORE UPDATE OF text_body,kind,sender_role,identity_scheme,external_key,binding_id,contact_id ON message
 BEGIN SELECT RAISE(ABORT,'message_immutable'); END;
CREATE TRIGGER goal_immutable BEFORE UPDATE OF target_json,target_descriptor,eligibility_json,grant_id,binding_id,contact_id ON read_goal
 BEGIN SELECT RAISE(ABORT,'history_target_immutable'); END;
`});
