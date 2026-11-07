import type {StorageMigration} from '../../storage/sqlite/contracts.ts';

/**
 * 迁移：为统一删除账本新增内部范围 `superseded_history`（ADR-175），并建立修复完成后的清理请求标记。
 *
 * - `deletion_operation` 的范围 CHECK 只能通过重建表来扩展。重建在同一事务内先复制行、删表、
 *   以原名重建再回填；`defer_foreign_keys` 让删表时对 `deletion_target`／`deletion_check`／
 *   `request_tombstone` 的外键检查推迟到提交，回填父行后违规计数归零，提交前仍由迁移的
 *   `foreign_key_check` 复核。
 * - 新范围与 `contact` 同形（只有联系人标识）。
 * - `history_superseded_cleanup` 只记录“哪位联系人的修复刚完成，需要清理被取代副本”，
 *   不含正文、名称或来源键；Finalize 与修复完成在同一事务写入，重启后据此续跑。
 */
export const supersededHistoryMigration=(version:number):StorageMigration=>({version,sql:`
PRAGMA defer_foreign_keys=ON;
CREATE TABLE deletion_operation_before_superseded AS SELECT * FROM deletion_operation;
DROP TABLE deletion_operation;
CREATE TABLE deletion_operation (
 operation_id TEXT PRIMARY KEY, owner_identity TEXT NOT NULL,
 request_namespace TEXT NOT NULL, request_key TEXT NOT NULL,
 scope_kind TEXT NOT NULL CHECK(scope_kind IN ('source','contact','contact_history','account','discussion','media_result_clear','media_result_replace','superseded_history')),
 contact_identity TEXT, source_identity TEXT, discussion_identity TEXT, message_identity TEXT,
 accepted_generation INTEGER NOT NULL CHECK(accepted_generation>=0),
 state TEXT NOT NULL CHECK(state IN ('fenced','cleaning','verifying','blocked','completed')),
 plan_revision INTEGER NOT NULL CHECK(plan_revision>0), domain_manifest TEXT NOT NULL,
 runner_token TEXT, runner_runtime TEXT, created_at INTEGER NOT NULL, completed_at INTEGER,
 UNIQUE(owner_identity,request_namespace,request_key), UNIQUE(owner_identity,operation_id),
 CHECK((scope_kind='account' AND contact_identity IS NULL AND source_identity IS NULL AND discussion_identity IS NULL AND message_identity IS NULL)
 OR (scope_kind='source' AND contact_identity IS NOT NULL AND source_identity IS NOT NULL AND discussion_identity IS NULL AND message_identity IS NULL)
 OR (scope_kind IN ('contact','contact_history','superseded_history') AND contact_identity IS NOT NULL AND source_identity IS NULL AND discussion_identity IS NULL AND message_identity IS NULL)
 OR (scope_kind='discussion' AND contact_identity IS NOT NULL AND source_identity IS NULL AND discussion_identity IS NOT NULL AND message_identity IS NULL)
 OR (scope_kind IN ('media_result_clear','media_result_replace') AND contact_identity IS NOT NULL AND source_identity IS NULL AND discussion_identity IS NULL AND message_identity IS NOT NULL)),
 CHECK((runner_token IS NULL)=(runner_runtime IS NULL)), CHECK((state='completed')=(completed_at IS NOT NULL))
) STRICT;
INSERT INTO deletion_operation SELECT * FROM deletion_operation_before_superseded;
DROP TABLE deletion_operation_before_superseded;
CREATE INDEX deletion_owner_progress ON deletion_operation(owner_identity,created_at,operation_id);
CREATE TABLE history_superseded_cleanup (
 owner_id TEXT NOT NULL, contact_id TEXT NOT NULL, requested_at INTEGER NOT NULL CHECK(requested_at>=0),
 PRIMARY KEY(owner_id,contact_id)
) STRICT;
`});
