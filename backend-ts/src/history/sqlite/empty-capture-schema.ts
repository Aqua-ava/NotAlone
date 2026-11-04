import type {StorageMigration} from '../../storage/sqlite/contracts.ts';

/**
 * 按目标查询抓取的索引：增量空页压缩与删除都按 (owner_id, goal_id) 查找，此前该外键列没有索引。
 * 迁移只建索引，不批量删除存量空页：在 1.9GB 真实库副本上一次性删除约 33 万行实测需 6–16 分钟，
 * 不能阻塞启动。存量空页在所属目标下一次接受空页时顺带清除，其余随终态目标的保留策略分批处理。
 */
export const historyEmptyCaptureMigration=(version:number):StorageMigration=>({version,sql:`
CREATE INDEX sync_capture_goal ON sync_capture(owner_id,goal_id);
`});
