import type { StorageMigration } from '../contracts.ts';

// 由registry在集成时赋连续版本；已发布SQL保持不变。
export function deletionMigration(version: number): StorageMigration {
  return { version, sql: `
CREATE TABLE deletion_operation (
 operation_id TEXT PRIMARY KEY, owner_identity TEXT NOT NULL,
 request_namespace TEXT NOT NULL, request_key TEXT NOT NULL,
 scope_kind TEXT NOT NULL CHECK(scope_kind IN ('source','contact','contact_history','account','discussion','media_result_clear','media_result_replace')),
 contact_identity TEXT, source_identity TEXT, discussion_identity TEXT, message_identity TEXT,
 accepted_generation INTEGER NOT NULL CHECK(accepted_generation>=0),
 state TEXT NOT NULL CHECK(state IN ('fenced','cleaning','verifying','blocked','completed')),
 plan_revision INTEGER NOT NULL CHECK(plan_revision>0), domain_manifest TEXT NOT NULL,
 runner_token TEXT, runner_runtime TEXT, created_at INTEGER NOT NULL, completed_at INTEGER,
 UNIQUE(owner_identity,request_namespace,request_key), UNIQUE(owner_identity,operation_id),
 CHECK((scope_kind='account' AND contact_identity IS NULL AND source_identity IS NULL AND discussion_identity IS NULL AND message_identity IS NULL)
 OR (scope_kind='source' AND contact_identity IS NOT NULL AND source_identity IS NOT NULL AND discussion_identity IS NULL AND message_identity IS NULL)
 OR (scope_kind IN ('contact','contact_history') AND contact_identity IS NOT NULL AND source_identity IS NULL AND discussion_identity IS NULL AND message_identity IS NULL)
 OR (scope_kind='discussion' AND contact_identity IS NOT NULL AND source_identity IS NULL AND discussion_identity IS NOT NULL AND message_identity IS NULL)
 OR (scope_kind IN ('media_result_clear','media_result_replace') AND contact_identity IS NOT NULL AND source_identity IS NULL AND discussion_identity IS NULL AND message_identity IS NOT NULL)),
 CHECK((runner_token IS NULL)=(runner_runtime IS NULL)), CHECK((state='completed')=(completed_at IS NOT NULL))
) STRICT;
CREATE INDEX deletion_owner_progress ON deletion_operation(owner_identity,created_at,operation_id);
CREATE TABLE deletion_target (
 operation_id TEXT NOT NULL REFERENCES deletion_operation(operation_id), target_no INTEGER NOT NULL CHECK(target_no>0),
 storage_kind TEXT NOT NULL CHECK(storage_kind IN ('row','file')), domain TEXT NOT NULL, target_key TEXT NOT NULL,
 row_kind TEXT, row_key_snapshot TEXT, managed_locator TEXT, expected_identity TEXT,
 target_payload TEXT, plan_revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','cleared','failed')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), last_error_code TEXT,
 PRIMARY KEY(operation_id,target_no), UNIQUE(operation_id,domain,target_key),
 CHECK((storage_kind='row' AND row_kind IS NOT NULL AND managed_locator IS NULL)
 OR (storage_kind='file' AND row_kind IS NULL AND row_key_snapshot IS NULL)),
 CHECK(state='cleared' OR (expected_identity IS NOT NULL AND target_payload IS NOT NULL))
) STRICT;
CREATE INDEX deletion_target_progress ON deletion_target(operation_id,state,target_no);
CREATE TABLE deletion_check (
 operation_id TEXT NOT NULL REFERENCES deletion_operation(operation_id), plan_revision INTEGER NOT NULL,
 check_kind TEXT NOT NULL CHECK(check_kind IN ('write_fence','database_rows','derived_eligibility','trace_payloads','request_replay','runtime_files','runtime_live_refs','sqlite_pages_wal','scope_suppression','final_recheck')),
 check_no TEXT NOT NULL, result TEXT NOT NULL CHECK(result IN ('passed','blocked','not_applicable')),
 checked_at INTEGER NOT NULL, verifier_version TEXT NOT NULL, minimal_proof TEXT NOT NULL,
 PRIMARY KEY(operation_id,plan_revision,check_kind,check_no)
) STRICT;
CREATE TABLE request_tombstone (
 owner_identity TEXT NOT NULL, request_namespace TEXT NOT NULL, request_key TEXT NOT NULL,
 invalidation_kind TEXT NOT NULL, authority_generation INTEGER NOT NULL CHECK(authority_generation>=0),
 deletion_operation_id TEXT, created_at INTEGER NOT NULL,
 PRIMARY KEY(owner_identity,request_namespace,request_key),
 FOREIGN KEY(owner_identity,deletion_operation_id) REFERENCES deletion_operation(owner_identity,operation_id)
) STRICT;
` };
}
