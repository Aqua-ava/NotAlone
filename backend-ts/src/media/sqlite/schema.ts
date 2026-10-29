import type { StorageMigration } from '../../storage/sqlite/contracts.ts';

// 版本由串行集成决定；已发布后不得修改SQL。
export const mediaMigration = (version: number): StorageMigration => ({version, sql: `
CREATE TABLE message_media (
 owner_id TEXT NOT NULL,message_id TEXT NOT NULL,contact_id TEXT NOT NULL,
 media_generation INTEGER NOT NULL DEFAULT 0 CHECK(media_generation>=0),
 head_revision INTEGER NOT NULL DEFAULT 0 CHECK(head_revision>=0),
 state TEXT NOT NULL CHECK(state IN ('active','cleared','invalidated','deleting')),created_at INTEGER NOT NULL CHECK(created_at>=0),
 PRIMARY KEY(owner_id,message_id),UNIQUE(owner_id,contact_id,message_id),
 FOREIGN KEY(owner_id,contact_id,message_id) REFERENCES message(owner_id,contact_id,id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE media_extraction_attempt (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,contact_id TEXT NOT NULL,message_id TEXT NOT NULL,
 request_key TEXT NOT NULL,attempt_no INTEGER NOT NULL CHECK(attempt_no>0),
 goal TEXT NOT NULL CHECK(goal IN ('extract','original_upgrade','audio_conversion')),
 record_id TEXT,input_file_id TEXT,
 accepted_media_generation INTEGER NOT NULL CHECK(accepted_media_generation>=0),
 accepted_head_revision INTEGER NOT NULL CHECK(accepted_head_revision>=0),
 accepted_data_generation INTEGER NOT NULL CHECK(accepted_data_generation>=0),
 accepted_read_epoch INTEGER,accepted_selection_generation INTEGER NOT NULL CHECK(accepted_selection_generation>=0),
 grant_id TEXT,binding_verification_id TEXT,runtime_token TEXT,eligibility_json TEXT,
 runtime_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','running','completed','failed','interrupted','revoked')),
 result_outcome TEXT NOT NULL CHECK(result_outcome IN ('full','limited','quality_unknown','no_result')),
 lease_token TEXT,lease_expires_at INTEGER,requested_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER,
 adapter_version TEXT NOT NULL,association_proof_format TEXT,association_proof TEXT,error_code TEXT,cleanup_operation_id TEXT,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,contact_id,message_id,id),UNIQUE(owner_id,request_key),UNIQUE(owner_id,message_id,attempt_no),
 FOREIGN KEY(owner_id,contact_id,message_id) REFERENCES message_media(owner_id,contact_id,message_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,contact_id,record_id,message_id) REFERENCES capture_record(owner_id,contact_id,id,message_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,grant_id) REFERENCES read_grant(owner_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,binding_verification_id) REFERENCES binding_verification(owner_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,input_file_id) REFERENCES media_file(owner_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((goal='audio_conversion' AND input_file_id IS NOT NULL AND record_id IS NULL AND accepted_read_epoch IS NULL AND grant_id IS NULL AND binding_verification_id IS NULL AND runtime_token IS NULL AND eligibility_json IS NULL)
 OR (goal IN ('extract','original_upgrade') AND input_file_id IS NULL AND record_id IS NOT NULL AND accepted_read_epoch IS NOT NULL AND grant_id IS NOT NULL AND binding_verification_id IS NOT NULL AND runtime_token IS NOT NULL AND eligibility_json IS NOT NULL)),
 CHECK((state='completed' AND result_outcome IN ('full','limited','quality_unknown') AND finished_at IS NOT NULL)
 OR (state<>'completed' AND result_outcome='no_result')),
 CHECK((state IN ('pending','running') AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND finished_at IS NULL)
 OR (state NOT IN ('pending','running') AND lease_token IS NULL AND lease_expires_at IS NULL)),
 CHECK((association_proof_format IS NULL)=(association_proof IS NULL))
) STRICT;
CREATE UNIQUE INDEX media_active_attempt ON media_extraction_attempt(owner_id,message_id) WHERE state IN ('pending','running');
CREATE INDEX media_attempt_record ON media_extraction_attempt(owner_id,contact_id,record_id);
CREATE INDEX media_attempt_input ON media_extraction_attempt(owner_id,input_file_id);
CREATE TABLE media_file (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,contact_id TEXT NOT NULL,message_id TEXT NOT NULL,produced_attempt_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('image_display','audio_source','audio_playback','video_playback')),
 image_quality TEXT NOT NULL CHECK(image_quality IN ('original','thumbnail','unknown','not_applicable')),
 quality_proof TEXT,format TEXT,mime_type TEXT,byte_size INTEGER CHECK(byte_size>0),content_digest TEXT,
 managed_locator TEXT,expected_file_identity TEXT,managed_address TEXT,parent_file_id TEXT,
 content_state TEXT NOT NULL CHECK(content_state IN ('present','erased')),
 publish_state TEXT NOT NULL CHECK(publish_state IN ('staged','current','retired','cleanup_pending')),
 container_valid INTEGER NOT NULL DEFAULT 0 CHECK(container_valid IN (0,1)),
 viewable INTEGER NOT NULL DEFAULT 0 CHECK(viewable IN (0,1)),playable INTEGER NOT NULL DEFAULT 0 CHECK(playable IN (0,1)),
 created_at INTEGER NOT NULL CHECK(created_at>=0),cleanup_operation_id TEXT,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,contact_id,message_id,id),UNIQUE(owner_id,managed_locator),
 FOREIGN KEY(owner_id,contact_id,message_id) REFERENCES message_media(owner_id,contact_id,message_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,contact_id,message_id,produced_attempt_id) REFERENCES media_extraction_attempt(owner_id,contact_id,message_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,contact_id,message_id,parent_file_id) REFERENCES media_file(owner_id,contact_id,message_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((role='image_display' AND image_quality IN ('original','thumbnail','unknown')) OR (role<>'image_display' AND image_quality='not_applicable')),
 CHECK(content_state='erased' OR image_quality<>'original' OR quality_proof IS NOT NULL),
 CHECK(publish_state<>'current' OR (content_state='present' AND managed_locator IS NOT NULL AND expected_file_identity IS NOT NULL AND managed_address IS NOT NULL AND format IS NOT NULL AND mime_type IS NOT NULL AND byte_size IS NOT NULL AND content_digest IS NOT NULL AND container_valid=1)),
 CHECK(content_state<>'erased' OR (managed_locator IS NULL AND expected_file_identity IS NULL AND managed_address IS NULL AND content_digest IS NULL AND quality_proof IS NULL))
) STRICT;
CREATE UNIQUE INDEX media_current_role ON media_file(owner_id,message_id,role) WHERE publish_state='current' AND content_state='present';
CREATE INDEX media_file_scope ON media_file(owner_id,message_id,publish_state);
CREATE INDEX media_file_producer ON media_file(owner_id,produced_attempt_id);
CREATE INDEX media_file_parent ON media_file(owner_id,parent_file_id);
CREATE TRIGGER media_head_kind BEFORE INSERT ON message_media WHEN NOT EXISTS (
 SELECT 1 FROM message WHERE owner_id=NEW.owner_id AND contact_id=NEW.contact_id AND id=NEW.message_id AND kind IN ('image','voice','video') AND availability='available')
 BEGIN SELECT RAISE(ABORT,'media_message_ineligible'); END;
CREATE TRIGGER media_file_parent_cycle BEFORE INSERT ON media_file WHEN NEW.parent_file_id=NEW.id OR EXISTS (
 WITH RECURSIVE chain(id,parent_file_id) AS (
 SELECT id,parent_file_id FROM media_file WHERE owner_id=NEW.owner_id AND id=NEW.parent_file_id
 UNION SELECT f.id,f.parent_file_id FROM media_file f JOIN chain p ON f.owner_id=NEW.owner_id AND f.id=p.parent_file_id)
 SELECT 1 FROM chain WHERE id=NEW.id OR parent_file_id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'media_parent_cycle'); END;
CREATE TRIGGER media_file_identity_immutable BEFORE UPDATE OF owner_id,id,contact_id,message_id,produced_attempt_id,role,parent_file_id ON media_file
 BEGIN SELECT RAISE(ABORT,'media_file_immutable'); END;
CREATE TRIGGER media_attempt_identity_immutable BEFORE UPDATE OF owner_id,id,contact_id,message_id,request_key,goal,record_id,input_file_id ON media_extraction_attempt
 BEGIN SELECT RAISE(ABORT,'media_attempt_immutable'); END;
`});
