import type {StorageMigration} from '../contracts.ts';
/** 迁移47：保留经核验的最小删除事实，退役重新认证和已清理副本流程。 */
export const historyRetirementMigration=(version:number):StorageMigration=>({version,sql:`
CREATE TABLE history_source_equivalence (
 owner_id TEXT NOT NULL, id TEXT NOT NULL, contact_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 generation_a TEXT NOT NULL,generation_b TEXT NOT NULL,partition_id TEXT NOT NULL,table_instance TEXT NOT NULL,
 local_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('prefix','point')),
 PRIMARY KEY(owner_id,id),FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id),
 CHECK(generation_a<>generation_b),CHECK((kind='prefix' AND local_id='') OR (kind='point' AND local_id<>''))
) STRICT;
CREATE INDEX history_source_equivalence_scope ON history_source_equivalence(owner_id,contact_id,conversation_id,partition_id,table_instance,local_id);
INSERT INTO history_source_equivalence
 SELECT json_extract(value,'$.owner_id'),notalone_sha256(value),json_extract(value,'$.contact_id'),json_extract(value,'$.conversation_id'),
 json_extract(value,'$.generation_a'),json_extract(value,'$.generation_b'),json_extract(value,'$.partition_id'),json_extract(value,'$.table_instance'),json_extract(value,'$.local_id'),json_extract(value,'$.kind')
 FROM json_each(notalone_history_deletion_equivalences_v1());
CREATE TEMP TABLE _history_retirement_check (n INTEGER CHECK(n=0));
INSERT INTO _history_retirement_check SELECT count(*) FROM deletion_operation WHERE scope_kind='superseded_history' AND state<>'completed';
CREATE TEMP TABLE _history_retired_operations AS SELECT value operation_id FROM json_each(notalone_history_retired_deletion_operations_v1());
DELETE FROM deletion_target WHERE operation_id IN(SELECT operation_id FROM _history_retired_operations)
 AND domain='history' AND row_kind IN ('history_source_recertification','history_source_recertification_cancel','history_superseded_cleanup');
DELETE FROM deletion_check WHERE operation_id IN(SELECT operation_id FROM _history_retired_operations);
UPDATE deletion_operation SET plan_revision=plan_revision+1,state='fenced',runner_token=NULL,runner_runtime=NULL
 WHERE operation_id IN(SELECT operation_id FROM _history_retired_operations);
DROP TABLE _history_retired_operations;
DELETE FROM deletion_check WHERE operation_id IN(SELECT operation_id FROM deletion_operation WHERE scope_kind='superseded_history');
DELETE FROM deletion_target WHERE operation_id IN(SELECT operation_id FROM deletion_operation WHERE scope_kind='superseded_history');
DELETE FROM request_tombstone WHERE deletion_operation_id IN(SELECT operation_id FROM deletion_operation WHERE scope_kind='superseded_history');
DELETE FROM deletion_operation WHERE scope_kind='superseded_history';
PRAGMA defer_foreign_keys=ON;
CREATE TEMP TABLE _history_retained_deletions AS SELECT * FROM deletion_operation;
DROP TABLE deletion_operation;
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
INSERT INTO deletion_operation SELECT * FROM _history_retained_deletions;
DROP TABLE _history_retained_deletions;
CREATE INDEX deletion_owner_progress ON deletion_operation(owner_identity,created_at,operation_id);
-- 旧换绑的预备页从未发布；保留明确围栏，禁止本机资格与同源自动恢复。
INSERT INTO source_proof(owner_id,contact_id,tables_json,state,reason)
 SELECT DISTINCT r.owner_id,r.contact_id,'','needs_confirmation','history_legacy_recertification_incomplete'
 FROM history_source_recertification r JOIN conversation_binding b ON b.owner_id=r.owner_id AND b.contact_id=r.contact_id AND b.id=r.new_binding_id
 JOIN contact c ON c.owner_id=r.owner_id AND c.id=r.contact_id
 WHERE r.state<>'completed' AND b.state<>'revoked' AND c.state='active'
 ON CONFLICT(owner_id,contact_id) DO UPDATE SET state='needs_confirmation',reason=excluded.reason;
DROP TABLE history_source_recertification_cancel;
DROP TABLE history_source_recertification;
DROP TABLE history_superseded_cleanup;
DROP TABLE _history_retirement_check;
`});
