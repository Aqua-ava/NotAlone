/** 保留既有文字引用；非文字证据使用内容引用，不编造字符位置。 */
import type {StorageMigration} from '../../storage/sqlite/contracts.ts';
import {memoryManagementMigration} from './management/schema.ts';
import {memoryAdjudicationMigration} from './management/adjudication-schema.ts';
import {memoryDocumentsMigration} from './documents/schema.ts';

const triggers=new Map<string,string>();
for(const sql of [memoryManagementMigration(11).sql,memoryAdjudicationMigration(12).sql,memoryDocumentsMigration(13).sql])
 for(const match of sql.matchAll(/CREATE TRIGGER (\w+)[\s\S]*?\bEND;/g))triggers.set(match[1]!,match[0]);
const affected=[...triggers].filter(([,sql])=>/\bmemory_citation\b/.test(sql));
const columns='owner_id,id,candidate_id,memory_id,version_no,source_contact_id,message_id,record_id,accepted_revision,span_start,span_end,explanation';
export const memoryContentCitationMigration=(version:number):StorageMigration=>({version,sql:`
${affected.map(([name])=>`DROP TRIGGER ${name};`).join('\n')}
CREATE TABLE memory_next_content_citation (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,candidate_id TEXT,memory_id TEXT,version_no INTEGER,source_contact_id TEXT NOT NULL,message_id TEXT NOT NULL,record_id TEXT NOT NULL,
 accepted_revision INTEGER NOT NULL,span_start INTEGER,span_end INTEGER,explanation TEXT,
 content_kind TEXT NOT NULL DEFAULT 'text',content_ref_json TEXT,
 PRIMARY KEY(owner_id,id),FOREIGN KEY(owner_id,candidate_id) REFERENCES memory_candidate(owner_id,id),
 FOREIGN KEY(owner_id,memory_id,version_no) REFERENCES memory_version(owner_id,memory_id,version_no),
 FOREIGN KEY(owner_id,source_contact_id,record_id,message_id) REFERENCES capture_record(owner_id,contact_id,id,message_id),
 CHECK((content_kind='text' AND span_start IS NOT NULL AND span_end IS NOT NULL AND span_start>=0 AND span_end>span_start AND content_ref_json IS NULL)
  OR (content_kind<>'text' AND length(content_kind)>0 AND span_start IS NULL AND span_end IS NULL AND content_ref_json IS NOT NULL AND json_valid(content_ref_json))),
 CHECK((candidate_id IS NOT NULL AND memory_id IS NULL AND version_no IS NULL) OR (candidate_id IS NULL AND memory_id IS NOT NULL AND version_no IS NOT NULL))
) STRICT;
INSERT INTO memory_next_content_citation(${columns}) SELECT ${columns} FROM memory_citation;
DROP TABLE memory_citation;
ALTER TABLE memory_next_content_citation RENAME TO memory_citation;
CREATE INDEX memory_citation_source ON memory_citation(owner_id,source_contact_id,record_id);
CREATE INDEX memory_citation_version ON memory_citation(owner_id,memory_id,version_no);
CREATE INDEX memory_citation_candidate ON memory_citation(owner_id,candidate_id);
${affected.map(([,sql])=>sql).join('\n')}
`});
