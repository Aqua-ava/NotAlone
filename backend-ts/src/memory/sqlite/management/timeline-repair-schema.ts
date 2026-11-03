import type {StorageMigration} from '../../../storage/sqlite/contracts.ts';

// 37可能在临时守卫失效时清空时间并清除dirty；只重新排队，由公开读取分批重建。
export const memoryManagementTimelineRepairMigration=(version:number):StorageMigration=>({version,sql:`
UPDATE memory SET management_timeline_dirty=1
 WHERE state='active' AND current_version_no IS NOT NULL AND management_source_time IS NULL;
`});
