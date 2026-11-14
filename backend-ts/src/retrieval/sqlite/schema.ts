import type {StorageMigration} from '../../storage/sqlite/contracts.ts';

const previousDeletionDomains=['discussion','discussion_calls','history','identity','media','memory_documents','memory_extraction','memory_management','reply_candidates','skill_metadata'];
const previousDeletionManifest=JSON.stringify(previousDeletionDomains);
const currentDeletionManifest=JSON.stringify([...previousDeletionDomains,'retrieval_index'].sort());

/** 只登记既有资料身份；正文分批建词法索引，向量由事务外本机推理补齐。 */
export const retrievalIndexMigration=(version:number):StorageMigration=>({version,sql:`
CREATE TABLE retrieval_document (
 id INTEGER PRIMARY KEY AUTOINCREMENT,owner_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('history','memory')),
 entity_id TEXT NOT NULL,contact_id TEXT,message_id TEXT,memory_id TEXT,memory_version_no INTEGER,
 text_seal TEXT NOT NULL,tokenizer_fingerprint TEXT NOT NULL,vector_seal TEXT,model_fingerprint TEXT,
 UNIQUE(owner_id,kind,entity_id),
 FOREIGN KEY(owner_id) REFERENCES owner(owner_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,contact_id,message_id) REFERENCES message(owner_id,contact_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,memory_id,memory_version_no) REFERENCES memory_version(owner_id,memory_id,version_no) DEFERRABLE INITIALLY DEFERRED,
 CHECK((kind='history' AND contact_id IS NOT NULL AND message_id=entity_id AND memory_id IS NULL AND memory_version_no IS NULL)
  OR(kind='memory' AND message_id IS NULL AND memory_id=entity_id AND memory_version_no IS NOT NULL)),
 CHECK((vector_seal IS NULL)=(model_fingerprint IS NULL))
) STRICT;
CREATE INDEX retrieval_document_scope ON retrieval_document(owner_id,contact_id,kind,id);
CREATE INDEX retrieval_document_vector_pending ON retrieval_document(owner_id,model_fingerprint,vector_seal,id);
CREATE TABLE retrieval_text_pending (
 owner_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('history','memory')),entity_id TEXT NOT NULL,contact_id TEXT,
 PRIMARY KEY(owner_id,kind,entity_id)
) STRICT,WITHOUT ROWID;
CREATE INDEX retrieval_text_pending_scope ON retrieval_text_pending(owner_id,contact_id,kind,entity_id);
CREATE VIRTUAL TABLE retrieval_fts USING fts5(tokens);
INSERT INTO retrieval_fts(retrieval_fts,rank) VALUES('secure-delete',1);
CREATE VIRTUAL TABLE retrieval_vec USING vec0(doc_id INTEGER PRIMARY KEY,embedding FLOAT[512] distance_metric=cosine);
INSERT INTO retrieval_text_pending SELECT owner_id,'history',id,contact_id FROM message WHERE kind='text' AND availability='available';
INSERT INTO retrieval_text_pending SELECT owner_id,'memory',id,contact_id FROM memory WHERE state='active';
`});

/** 56已进入开发实例，游标与既存删除恢复只能沿后续正式迁移追加。 */
export const retrievalIndexRecoveryMigration=(version:number):StorageMigration=>({version,sql:`
CREATE TABLE retrieval_vector_cursor (
 owner_id TEXT NOT NULL,contact_key TEXT NOT NULL,model_fingerprint TEXT NOT NULL,last_doc_id INTEGER NOT NULL CHECK(last_doc_id>=0),
 PRIMARY KEY(owner_id,contact_key,model_fingerprint)
) STRICT,WITHOUT ROWID;
-- 只升级精确已知的旧删除装配；推进计划使旧复核和runner失效，claim仍按真实闭包重新收集。
UPDATE deletion_operation SET domain_manifest='${currentDeletionManifest}',plan_revision=plan_revision+1,
 state='fenced',runner_token=NULL,runner_runtime=NULL
 WHERE state<>'completed' AND domain_manifest='${previousDeletionManifest}';
`});
