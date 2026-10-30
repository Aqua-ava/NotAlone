import type {StorageMigration} from '../../storage/sqlite/contracts.ts';

/** 来源身份与待核验状态的精确查找索引。 */
export const historyObservationIndexMigration=(version:number):StorageMigration=>({version,sql:`
CREATE INDEX capture_record_observed_source ON capture_record(owner_id,contact_id,observed_key) WHERE availability='available';
CREATE INDEX capture_record_quarantined_source ON capture_record(owner_id,contact_id,observed_key,capture_id,item_no,reason_code) WHERE state='quarantined' AND availability='available';
`});
