import type {StorageMigration} from '../../storage/sqlite/contracts.ts';

/** Quote facts are a narrow projection beside the immutable non-text message/source rows. */
export const historyQuoteMigration=(version:number):StorageMigration=>({version,sql:`
CREATE TABLE history_quote (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,contact_id TEXT NOT NULL,message_id TEXT NOT NULL,binding_id TEXT NOT NULL,
 source_record_id TEXT NOT NULL,source_generation TEXT NOT NULL,version TEXT NOT NULL,
 reply_text TEXT NOT NULL,referenced_text TEXT,referenced_sender TEXT,
 referenced_sender_role TEXT NOT NULL CHECK(referenced_sender_role IN ('owner','contact','unknown')),
 referenced_type TEXT,referenced_server_id TEXT,target_message_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('resolved','unresolved','unavailable')),
 proof_digest TEXT NOT NULL CHECK(length(proof_digest)=64),source_revision INTEGER NOT NULL CHECK(source_revision>0),
 interpretation_revision INTEGER NOT NULL CHECK(interpretation_revision>0),carrier_interpretation_revision INTEGER NOT NULL CHECK(carrier_interpretation_revision>0),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,contact_id,message_id),
 FOREIGN KEY(owner_id,contact_id,binding_id,message_id) REFERENCES message(owner_id,contact_id,binding_id,id),
 FOREIGN KEY(owner_id,contact_id,source_record_id,message_id) REFERENCES capture_record(owner_id,contact_id,id,message_id),
 FOREIGN KEY(owner_id,contact_id,binding_id,target_message_id) REFERENCES message(owner_id,contact_id,binding_id,id),
 CHECK(length(version) BETWEEN 1 AND 128),CHECK(length(reply_text) BETWEEN 1 AND 1000000),
 CHECK(referenced_text IS NULL OR length(referenced_text)<=1000000),
 CHECK(referenced_sender IS NULL OR length(referenced_sender)<=255),
 CHECK(referenced_type IS NULL OR length(referenced_type)<=128),
 CHECK(referenced_server_id IS NULL OR length(referenced_server_id)<=20),
 CHECK((target_message_id IS NOT NULL AND state='resolved') OR (target_message_id IS NULL AND state<>'resolved'))
) STRICT;
CREATE INDEX history_quote_target ON history_quote(owner_id,contact_id,target_message_id);
CREATE TABLE history_quote_attempt (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,contact_id TEXT NOT NULL,message_id TEXT NOT NULL,binding_id TEXT NOT NULL,
 record_id TEXT NOT NULL,source_generation TEXT NOT NULL,version TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('saved','failed')),error_code TEXT,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,contact_id,message_id,record_id,source_generation,version),
 FOREIGN KEY(owner_id,contact_id,binding_id,message_id) REFERENCES message(owner_id,contact_id,binding_id,id),
 FOREIGN KEY(owner_id,contact_id,record_id,message_id) REFERENCES capture_record(owner_id,contact_id,id,message_id),
 CHECK((outcome='saved' AND error_code IS NULL) OR (outcome='failed' AND error_code IS NOT NULL)),
 CHECK(length(version) BETWEEN 1 AND 128)
) STRICT;
CREATE INDEX history_quote_attempt_message ON history_quote_attempt(owner_id,contact_id,message_id);
`});

/** v26 把重复捕获收敛到稳定来源键，并记下解析时的载体解释与状态版本。 */
export const historyQuoteRevisionMigration=(version:number):StorageMigration=>({version,sql:`
ALTER TABLE history_quote ADD COLUMN source_key TEXT NOT NULL DEFAULT '';
UPDATE history_quote SET source_key=coalesce((SELECT r.observed_key FROM capture_record r
 WHERE r.owner_id=history_quote.owner_id AND r.contact_id=history_quote.contact_id AND r.id=history_quote.source_record_id AND r.message_id=history_quote.message_id),'');
CREATE TABLE history_quote_attempt_v26 (
 owner_id TEXT NOT NULL,id TEXT NOT NULL,contact_id TEXT NOT NULL,message_id TEXT NOT NULL,binding_id TEXT NOT NULL,
 record_id TEXT NOT NULL,source_key TEXT NOT NULL,source_generation TEXT NOT NULL,version TEXT NOT NULL,
 carrier_interpretation_revision INTEGER NOT NULL CHECK(carrier_interpretation_revision>0),carrier_status TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('saved','failed')),error_code TEXT,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,contact_id,message_id,source_generation,source_key,version,carrier_interpretation_revision,carrier_status),
 FOREIGN KEY(owner_id,contact_id,binding_id,message_id) REFERENCES message(owner_id,contact_id,binding_id,id),
 FOREIGN KEY(owner_id,contact_id,record_id,message_id) REFERENCES capture_record(owner_id,contact_id,id,message_id),
 CHECK((outcome='saved' AND error_code IS NULL) OR (outcome='failed' AND error_code IS NOT NULL)),
 CHECK(length(version) BETWEEN 1 AND 128)
) STRICT;
WITH ranked AS (
 SELECT a.owner_id,a.id,a.contact_id,a.message_id,a.binding_id,a.record_id,coalesce(r.observed_key,'') source_key,a.source_generation,a.version,
  m.interpretation_revision carrier_interpretation_revision,coalesce(m.status_code,'') carrier_status,a.outcome,a.error_code,
  row_number() OVER(PARTITION BY a.owner_id,a.contact_id,a.message_id,a.source_generation,coalesce(r.observed_key,''),a.version,
    m.interpretation_revision,coalesce(m.status_code,'') ORDER BY CASE WHEN a.outcome='saved' THEN 0 ELSE 1 END,a.id) rank_no
 FROM history_quote_attempt a JOIN capture_record r ON r.owner_id=a.owner_id AND r.contact_id=a.contact_id AND r.id=a.record_id AND r.message_id=a.message_id
 JOIN message m ON m.owner_id=a.owner_id AND m.contact_id=a.contact_id AND m.id=a.message_id
)
INSERT INTO history_quote_attempt_v26(owner_id,id,contact_id,message_id,binding_id,record_id,source_key,source_generation,version,
 carrier_interpretation_revision,carrier_status,outcome,error_code)
SELECT owner_id,id,contact_id,message_id,binding_id,record_id,source_key,source_generation,version,carrier_interpretation_revision,carrier_status,outcome,error_code
FROM ranked WHERE rank_no=1 AND source_key<>'';
DROP TABLE history_quote_attempt;
ALTER TABLE history_quote_attempt_v26 RENAME TO history_quote_attempt;
CREATE INDEX history_quote_attempt_message ON history_quote_attempt(owner_id,contact_id,message_id);
`});
