import type {StorageMigration} from '../../storage/sqlite/contracts.ts';

/** 首次启用只处理之后新增的资料；旧消息及原始来源均不改写。 */
export const memoryIncrementalBaselineMigration=(version:number):StorageMigration=>({version,sql:`
ALTER TABLE database_instance ADD COLUMN memory_incremental_baseline_display_no INTEGER NOT NULL DEFAULT 0 CHECK(memory_incremental_baseline_display_no>=0);
UPDATE database_instance SET memory_incremental_baseline_display_no=(SELECT coalesce(max(display_no),0) FROM message) WHERE slot=1;
CREATE TRIGGER memory_incremental_baseline_immutable BEFORE UPDATE OF memory_incremental_baseline_display_no ON database_instance
 BEGIN SELECT RAISE(ABORT,'memory_incremental_baseline_immutable'); END;
`});
