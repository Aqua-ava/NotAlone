import type {StorageMigration} from '../../storage/sqlite/contracts.ts';

/** 折叠来源事实；迁移不读取微信、不重签授权，也不把旧租约当作当前运行守卫。 */
export const historySourceProofMigration=(version:number):StorageMigration=>({version,sql:`
CREATE TABLE source_proof (
 owner_id TEXT NOT NULL,contact_id TEXT NOT NULL,
 account_key TEXT,conversation_id TEXT,conversation_key TEXT,source_generation TEXT,
 tables_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('ok','needs_confirmation')),
 checked_at INTEGER,reason TEXT,
 PRIMARY KEY(owner_id,contact_id),
 FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id),
 FOREIGN KEY(owner_id,conversation_id) REFERENCES channel_conversation(owner_id,id),
 CHECK(state<>'ok' OR (account_key IS NOT NULL AND conversation_key IS NOT NULL
  AND conversation_id IS NOT NULL AND source_generation IS NOT NULL AND tables_json<>''))
) STRICT;
WITH candidates AS (
 SELECT owner_id,contact_id FROM history_continuity_scope
 UNION SELECT owner_id,contact_id FROM history_continuity_fence
 UNION SELECT owner_id,contact_id FROM history_guard_lease
), facts AS (
 SELECT c.owner_id,c.contact_id,
  CASE WHEN json_valid(s.tables_json) THEN json_extract(s.tables_json,'$.accountKey') END AS account_key,
  coalesce(s.conversation_id,l.conversation_id,b.conversation_id) AS conversation_id,
  v.external_key AS conversation_key,coalesce(s.source_generation,l.source_generation,a.source_generation) AS source_generation,
  coalesce(s.tables_json,'') AS tables_json,
  CASE WHEN f.contact_id IS NULL AND s.conversation_id=b.conversation_id AND b.state='verified'
   AND a.identity_state='verified' AND s.source_generation=a.source_generation
   AND CASE WHEN json_valid(s.tables_json) THEN json_extract(s.tables_json,'$.accountKey')=a.external_key
    AND json_type(s.tables_json,'$.accountKey')='text' AND length(a.external_key)>0 AND length(a.source_generation)>0
    AND json_type(s.tables_json,'$.partitions')='array' AND json_array_length(s.tables_json,'$.partitions') BETWEEN 1 AND 10000
    AND NOT EXISTS(SELECT 1 FROM json_each(s.tables_json,'$.partitions') p WHERE p.type<>'text' OR length(p.value)<1 OR length(p.value)>512)
    AND (SELECT count(DISTINCT p.value) FROM json_each(s.tables_json,'$.partitions') p)=json_array_length(s.tables_json,'$.partitions')
    AND json_type(s.tables_json,'$.tables')='array' AND json_array_length(s.tables_json,'$.tables')<=10000
    AND NOT EXISTS(SELECT 1 FROM json_each(s.tables_json,'$.tables') t WHERE coalesce(CASE WHEN t.type='array' THEN
     json_array_length(t.value)=2 AND json_type(t.value,'$[0]')='text' AND length(json_extract(t.value,'$[0]')) BETWEEN 1 AND 512
     AND json_type(t.value,'$[1]')='text' AND length(json_extract(t.value,'$[1]')) BETWEEN 1 AND 512
     AND EXISTS(SELECT 1 FROM json_each(s.tables_json,'$.partitions') p WHERE p.value=json_extract(t.value,'$[0]')) ELSE 0 END,0)=0)
    AND (SELECT count(DISTINCT CASE WHEN t.type='array' THEN json_array(json_extract(t.value,'$[0]'),json_extract(t.value,'$[1]')) END)
     FROM json_each(s.tables_json,'$.tables') t)=json_array_length(s.tables_json,'$.tables')
    AND (json_type(s.tables_json,'$.checkedPartitions') IS NULL OR
     (json_type(s.tables_json,'$.checkedPartitions')='array' AND json_array_length(s.tables_json,'$.checkedPartitions') BETWEEN 1 AND 128
      AND NOT EXISTS(SELECT 1 FROM json_each(s.tables_json,'$.checkedPartitions') p WHERE p.type<>'text' OR length(p.value)<1 OR length(p.value)>512)
      AND (SELECT count(DISTINCT p.value) FROM json_each(s.tables_json,'$.checkedPartitions') p)=json_array_length(s.tables_json,'$.checkedPartitions')
      AND NOT EXISTS(SELECT 1 FROM json_each(s.tables_json,'$.partitions') p WHERE NOT EXISTS
       (SELECT 1 FROM json_each(s.tables_json,'$.checkedPartitions') q WHERE q.value=p.value)))) ELSE 0 END
   THEN 'ok' ELSE 'needs_confirmation' END AS state,
  coalesce(f.reason,'history_source_continuity_unverified') AS reason
 FROM candidates c
 LEFT JOIN history_continuity_scope s ON s.owner_id=c.owner_id AND s.contact_id=c.contact_id
 LEFT JOIN history_continuity_fence f ON f.owner_id=c.owner_id AND f.contact_id=c.contact_id
 LEFT JOIN history_guard_lease l ON l.owner_id=c.owner_id AND l.contact_id=c.contact_id
 LEFT JOIN conversation_binding b ON b.owner_id=c.owner_id AND b.contact_id=c.contact_id AND b.state<>'revoked'
 LEFT JOIN channel_conversation v ON v.owner_id=c.owner_id AND v.id=coalesce(s.conversation_id,l.conversation_id,b.conversation_id)
 LEFT JOIN channel_account a ON a.owner_id=v.owner_id AND a.id=v.account_id
)
INSERT INTO source_proof(owner_id,contact_id,account_key,conversation_id,conversation_key,source_generation,tables_json,state,checked_at,reason)
 SELECT owner_id,contact_id,account_key,conversation_id,conversation_key,source_generation,tables_json,state,NULL,
 CASE WHEN state='ok' THEN NULL ELSE reason END FROM facts;
CREATE TEMP TABLE _source_proof_deletion_check(n INTEGER NOT NULL CHECK(n=0));
INSERT INTO _source_proof_deletion_check
 SELECT count(*) FROM deletion_target t JOIN deletion_operation o ON o.operation_id=t.operation_id
 WHERE o.state<>'completed' AND t.domain='history' AND t.storage_kind='row'
 AND t.row_kind IN ('history_continuity_fence','history_continuity_scope','history_guard_lease')
 AND coalesce(CASE WHEN t.row_key_snapshot IS NULL THEN t.state='cleared'
  WHEN json_valid(t.row_key_snapshot) THEN json_type(t.row_key_snapshot)='object'
   AND (SELECT count(*) FROM json_each(t.row_key_snapshot))=2
   AND json_type(t.row_key_snapshot,'$.owner_id')='text'
   AND json_type(t.row_key_snapshot,'$.contact_id')='text'
   AND json_extract(t.row_key_snapshot,'$.owner_id')=o.owner_identity
   AND (o.scope_kind='account' OR json_extract(t.row_key_snapshot,'$.contact_id')=o.contact_identity)
   AND (t.state='cleared' OR EXISTS(SELECT 1 FROM contact c WHERE c.owner_id=o.owner_identity AND c.id=json_extract(t.row_key_snapshot,'$.contact_id')))
  ELSE 0 END,0)=0;
CREATE TEMP TABLE _source_proof_deletion_operations AS
 SELECT DISTINCT t.operation_id FROM deletion_target t JOIN deletion_operation o ON o.operation_id=t.operation_id
 WHERE o.state<>'completed' AND t.domain='history' AND t.storage_kind='row'
 AND t.row_kind IN ('history_continuity_fence','history_continuity_scope','history_guard_lease');
CREATE TEMP TABLE _source_proof_deletion_targets AS
WITH grouped AS (
 SELECT t.operation_id,min(t.target_no) AS target_no,o.owner_identity AS owner_id,
  json_extract(t.row_key_snapshot,'$.contact_id') AS contact_id,
  max(o.plan_revision)+1 AS plan_revision,max(o.scope_kind) AS scope_kind,
  max(o.accepted_generation) AS accepted_generation,sum(t.attempts) AS attempts,
  CASE WHEN sum(t.state<>'cleared')>0 OR EXISTS(SELECT 1 FROM source_proof p WHERE p.owner_id=o.owner_identity
   AND p.contact_id=json_extract(t.row_key_snapshot,'$.contact_id')) THEN 'pending' ELSE 'cleared' END AS state
 FROM deletion_target t JOIN deletion_operation o ON o.operation_id=t.operation_id
 WHERE o.state<>'completed' AND t.domain='history' AND t.storage_kind='row' AND t.row_key_snapshot IS NOT NULL
 AND t.row_kind IN ('history_continuity_fence','history_continuity_scope','history_guard_lease')
 GROUP BY t.operation_id,o.owner_identity,json_extract(t.row_key_snapshot,'$.contact_id')
), identities AS (
 SELECT *,json_object('contact_id',contact_id,'owner_id',owner_id) AS row_key,
  notalone_sha256(json_array('source_proof',json_array(json_array('contact_id',contact_id),json_array('owner_id',owner_id)))) AS identity
 FROM grouped
)
SELECT operation_id,target_no,plan_revision,attempts,state,row_key,
 notalone_sha256(json_array('source_proof',json(row_key),identity)) AS target_key,json_quote(identity) AS expected_identity,
 json_object('domain','history','holderKeys',json(CASE WHEN scope_kind='account' THEN
  (SELECT json_group_array('history:'||g.id) FROM read_goal g WHERE g.owner_id=identities.owner_id)
  ELSE (SELECT json_group_array('history:'||g.id) FROM read_goal g WHERE g.owner_id=identities.owner_id
   AND g.contact_id=identities.contact_id AND g.accepted_data_generation<identities.accepted_generation) END),
  'identity',identity,'key',json(row_key),'kind','row','rowKind','source_proof') AS target_payload
 FROM identities;
DELETE FROM deletion_target WHERE operation_id IN (SELECT operation_id FROM _source_proof_deletion_operations)
 AND domain='history' AND storage_kind='row' AND row_kind IN ('history_continuity_fence','history_continuity_scope','history_guard_lease');
INSERT INTO deletion_target(operation_id,target_no,storage_kind,domain,target_key,row_kind,row_key_snapshot,expected_identity,target_payload,plan_revision,state,attempts)
 SELECT operation_id,target_no,'row','history',target_key,'source_proof',row_key,expected_identity,target_payload,plan_revision,state,attempts
 FROM _source_proof_deletion_targets;
UPDATE deletion_operation SET plan_revision=plan_revision+1,state='fenced',runner_token=NULL,runner_runtime=NULL
 WHERE operation_id IN (SELECT operation_id FROM _source_proof_deletion_operations);
DROP TABLE _source_proof_deletion_targets;
DROP TABLE _source_proof_deletion_operations;
DROP TABLE _source_proof_deletion_check;
DROP TABLE history_guard_lease;
DROP TABLE history_continuity_scope;
DROP TABLE history_continuity_fence;
`});
