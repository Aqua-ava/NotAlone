import type { StorageMigration } from '../../storage/sqlite/contracts.ts';

/**
 * 06 清空聊天的精确渠道边界与显式重读授权。
 *
 * history_cutoff 是某次清空操作持有的源快照切面 B：只有完整 manifest 与精确成员
 * 在同一事务持久化后才允许原子接受；pending 期间成员不是正式排除。
 * history_restore 是用户明确重读时的新核验/新授权记录，只保留受控快照标识。
 */
export const historyClearMigration = (version: number): StorageMigration => ({ version, sql: `
CREATE TABLE history_cutoff (
 owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL, barrier_generation INTEGER NOT NULL CHECK(barrier_generation>0),
 operation_id TEXT NOT NULL, contact_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','verified','blocked')),
 source_generation TEXT, account_key TEXT, conversation_key TEXT,
 protocol TEXT, target_json TEXT, support_json TEXT, proof_json TEXT,
 manifest_sha256 TEXT, boundary_token TEXT, member_count INTEGER, reason TEXT,
 established_at INTEGER, created_at INTEGER NOT NULL,
 PRIMARY KEY(owner_id,conversation_id,barrier_generation), UNIQUE(owner_id,operation_id),
 FOREIGN KEY(owner_id,conversation_id) REFERENCES channel_conversation(owner_id,id),
 FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id),
 FOREIGN KEY(owner_id,operation_id) REFERENCES deletion_operation(owner_identity,operation_id),
 CHECK(established_at IS NULL OR state='verified'),
 CHECK((state='pending' AND established_at IS NULL) OR (state='verified' AND established_at IS NOT NULL
  AND source_generation IS NOT NULL AND account_key IS NOT NULL AND conversation_key IS NOT NULL
  AND protocol IS NOT NULL AND target_json IS NOT NULL AND support_json IS NOT NULL AND proof_json IS NOT NULL
  AND manifest_sha256 IS NOT NULL AND boundary_token IS NOT NULL AND member_count IS NOT NULL)
  OR (state='blocked' AND established_at IS NULL AND member_count IS NULL))
) STRICT;
CREATE TABLE history_cutoff_member (
 owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL, barrier_generation INTEGER NOT NULL,
 member_no INTEGER NOT NULL CHECK(member_no>=0), partition TEXT NOT NULL, table_instance TEXT NOT NULL,
 scheme TEXT NOT NULL CHECK(scheme='local'), external_key TEXT NOT NULL,
 PRIMARY KEY(owner_id,conversation_id,barrier_generation,member_no),
 UNIQUE(owner_id,conversation_id,barrier_generation,scheme,external_key),
 FOREIGN KEY(owner_id,conversation_id,barrier_generation) REFERENCES history_cutoff(owner_id,conversation_id,barrier_generation)
) STRICT;
CREATE INDEX history_cutoff_member_identity ON history_cutoff_member(owner_id,conversation_id,scheme,external_key);
CREATE TABLE history_restore (
 owner_id TEXT NOT NULL, request_key TEXT NOT NULL, contact_id TEXT NOT NULL, authorization_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL, binding_id TEXT NOT NULL, verification_id TEXT NOT NULL, grant_id TEXT NOT NULL,
 selection_generation INTEGER NOT NULL CHECK(selection_generation>0),
 barrier_generation INTEGER NOT NULL CHECK(barrier_generation>=0),
 cutoff_operation_id TEXT, goal_id TEXT, state TEXT NOT NULL CHECK(state IN ('authorized','active','completed')),
 created_at INTEGER NOT NULL, completed_at INTEGER,
 PRIMARY KEY(owner_id,request_key), UNIQUE(owner_id,authorization_id),
 FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id),
 FOREIGN KEY(owner_id,conversation_id) REFERENCES channel_conversation(owner_id,id),
 FOREIGN KEY(owner_id,binding_id) REFERENCES conversation_binding(owner_id,id),
 FOREIGN KEY(owner_id,goal_id) REFERENCES read_goal(owner_id,id) ON DELETE SET NULL,
 CHECK((state='completed')=(completed_at IS NOT NULL))
) STRICT;
CREATE INDEX history_restore_contact ON history_restore(owner_id,contact_id,created_at);
` });
