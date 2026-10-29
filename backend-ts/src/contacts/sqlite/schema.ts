import type { StorageMigration } from '../../storage/sqlite/contracts.ts';

// 版本由集成注册表分配；已集成后不得修改 SQL。
export const identityMigration = (version: number): StorageMigration => ({ version, sql: `
CREATE TABLE owner (
 owner_id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','deleting','deleted')), read_enabled INTEGER NOT NULL DEFAULT 0 CHECK(read_enabled IN (0,1)),
 read_epoch INTEGER NOT NULL DEFAULT 0 CHECK(read_epoch>=0), created_at INTEGER NOT NULL,
 memory_revision INTEGER NOT NULL DEFAULT 0, preference_revision INTEGER NOT NULL DEFAULT 0,
 skill_revision INTEGER NOT NULL DEFAULT 0, document_revision INTEGER NOT NULL DEFAULT 0,
 feedback_revision INTEGER NOT NULL DEFAULT 0, current_publication_id TEXT
) STRICT;
CREATE TABLE contact (
 owner_id TEXT NOT NULL, id TEXT NOT NULL, display_name TEXT, remark TEXT,
 selection_generation INTEGER NOT NULL DEFAULT 0 CHECK(selection_generation>=0),
 data_generation INTEGER NOT NULL DEFAULT 0 CHECK(data_generation>=0),
 source_revision INTEGER NOT NULL DEFAULT 0, memory_revision INTEGER NOT NULL DEFAULT 0,
 document_revision INTEGER NOT NULL DEFAULT 0, feedback_revision INTEGER NOT NULL DEFAULT 0,
 current_publication_id TEXT, state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','deleting','deleted')),
 PRIMARY KEY(owner_id,id), FOREIGN KEY(owner_id) REFERENCES owner(owner_id)
) STRICT;
CREATE TABLE channel_account (
 owner_id TEXT NOT NULL, id TEXT NOT NULL, identity_scheme TEXT NOT NULL, external_key TEXT NOT NULL,
 display_name TEXT, identity_state TEXT NOT NULL CHECK(identity_state IN ('verified','unavailable','revoked')),
 source_generation TEXT NOT NULL, scope_mode TEXT NOT NULL DEFAULT 'selected' CHECK(scope_mode IN ('selected','all_private')),
 scope_revision INTEGER NOT NULL DEFAULT 0 CHECK(scope_revision>=0), scope_confirmed_at INTEGER,
 PRIMARY KEY(owner_id,id), UNIQUE(owner_id,identity_scheme,external_key),
 FOREIGN KEY(owner_id) REFERENCES owner(owner_id)
) STRICT;
CREATE UNIQUE INDEX current_wechat_account ON channel_account(owner_id) WHERE identity_state='verified';
CREATE TABLE channel_conversation (
 owner_id TEXT NOT NULL, id TEXT NOT NULL, account_id TEXT NOT NULL, identity_scheme TEXT NOT NULL,
 external_key TEXT NOT NULL, display_name TEXT, barrier_generation INTEGER NOT NULL DEFAULT 0 CHECK(barrier_generation>=0),
 PRIMARY KEY(owner_id,id), UNIQUE(owner_id,account_id,identity_scheme,external_key),
 FOREIGN KEY(owner_id,account_id) REFERENCES channel_account(owner_id,id)
) STRICT;
CREATE TABLE conversation_binding (
 owner_id TEXT NOT NULL, id TEXT NOT NULL, contact_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 identity_generation INTEGER NOT NULL DEFAULT 0 CHECK(identity_generation>=0),
 state TEXT NOT NULL CHECK(state IN ('verified','needs_confirmation','revoked')),
 PRIMARY KEY(owner_id,id), UNIQUE(owner_id,contact_id,id),
 FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id),
 FOREIGN KEY(owner_id,conversation_id) REFERENCES channel_conversation(owner_id,id)
) STRICT;
CREATE UNIQUE INDEX verified_conversation_binding ON conversation_binding(owner_id,conversation_id) WHERE state<>'revoked';
CREATE UNIQUE INDEX verified_contact_binding ON conversation_binding(owner_id,contact_id) WHERE state<>'revoked';
CREATE TRIGGER binding_identity_immutable BEFORE UPDATE OF owner_id,id,contact_id,conversation_id ON conversation_binding
 BEGIN SELECT RAISE(ABORT,'binding_identity_immutable'); END;
CREATE TABLE binding_verification (
 owner_id TEXT NOT NULL, id TEXT NOT NULL, binding_id TEXT NOT NULL, identity_generation INTEGER NOT NULL,
 method TEXT NOT NULL CHECK(method IN ('channel_metadata','foreground_confirmation')),
 proof_format TEXT NOT NULL CHECK(proof_format='identity-metadata-v1'), proof TEXT NOT NULL CHECK(json_valid(proof)), verified_at INTEGER NOT NULL,
 PRIMARY KEY(owner_id,id), UNIQUE(owner_id,binding_id,id),
 FOREIGN KEY(owner_id,binding_id) REFERENCES conversation_binding(owner_id,id)
) STRICT;
CREATE TRIGGER verification_immutable BEFORE UPDATE ON binding_verification
 BEGIN SELECT RAISE(ABORT,'verification_immutable'); END;
CREATE TABLE read_grant (
 owner_id TEXT NOT NULL, id TEXT NOT NULL, contact_id TEXT NOT NULL, binding_id TEXT NOT NULL,
 verification_id TEXT NOT NULL, selection_generation INTEGER NOT NULL CHECK(selection_generation>0),
 granted_at INTEGER NOT NULL, revoked_at INTEGER, reason TEXT,
 PRIMARY KEY(owner_id,id), UNIQUE(owner_id,contact_id,selection_generation), UNIQUE(owner_id,contact_id,binding_id,id),
 FOREIGN KEY(owner_id,contact_id,binding_id) REFERENCES conversation_binding(owner_id,contact_id,id),
 FOREIGN KEY(owner_id,binding_id,verification_id) REFERENCES binding_verification(owner_id,binding_id,id),
 CHECK((revoked_at IS NULL AND reason IS NULL) OR (revoked_at IS NOT NULL AND reason IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX active_contact_read_grant ON read_grant(owner_id,contact_id) WHERE revoked_at IS NULL;
CREATE TRIGGER grant_verification_generation BEFORE INSERT ON read_grant
 WHEN NOT EXISTS(SELECT 1 FROM binding_verification v JOIN conversation_binding b ON b.owner_id=v.owner_id AND b.id=v.binding_id
 JOIN contact c ON c.owner_id=b.owner_id AND c.id=b.contact_id
 WHERE v.owner_id=NEW.owner_id AND v.id=NEW.verification_id AND v.binding_id=NEW.binding_id
 AND v.identity_generation=b.identity_generation AND b.state='verified' AND c.state='active'
 AND c.selection_generation=NEW.selection_generation)
 BEGIN SELECT RAISE(ABORT,'grant_verification_generation'); END;
CREATE TRIGGER grant_identity_immutable BEFORE UPDATE OF owner_id,id,contact_id,binding_id,verification_id,selection_generation,granted_at ON read_grant
 BEGIN SELECT RAISE(ABORT,'grant_identity_immutable'); END;
CREATE TRIGGER grant_revocation_final BEFORE UPDATE ON read_grant WHEN OLD.revoked_at IS NOT NULL
 BEGIN SELECT RAISE(ABORT,'grant_revocation_final'); END;
CREATE TABLE manual_confirmation (
 owner_id TEXT NOT NULL, id TEXT NOT NULL, contact_id TEXT NOT NULL, context_token TEXT NOT NULL,
 accepted_data_generation INTEGER NOT NULL, confirmed_at INTEGER NOT NULL, revoked_at INTEGER,
 state TEXT NOT NULL CHECK(state IN ('active','revoked')),
 PRIMARY KEY(owner_id,id), UNIQUE(owner_id,context_token),
 FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id)
) STRICT;
CREATE TRIGGER manual_identity_immutable BEFORE UPDATE OF owner_id,id,contact_id,context_token,accepted_data_generation,confirmed_at ON manual_confirmation
 BEGIN SELECT RAISE(ABORT,'manual_identity_immutable'); END;
` });
