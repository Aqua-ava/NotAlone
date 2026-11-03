import type {StorageMigration} from '../../../storage/sqlite/contracts.ts';

// 待处理列表按状态和游标一起定位，已采纳历史增长不增加本页扫描量。
export const memoryManagementPendingIndexMigration=(version:number):StorageMigration=>({version,sql:`
CREATE INDEX candidate_management_pending_page ON memory_candidate(owner_id,scope_kind,contact_id,state,id);
`});
