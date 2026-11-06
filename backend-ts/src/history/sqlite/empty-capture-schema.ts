import type {StorageMigration} from '../../storage/sqlite/contracts.ts';

/**
 * 按目标查询抓取的索引：增量空页压缩与删除都按 (owner_id, goal_id) 查找，此前该外键列没有索引。
 * 迁移只建索引，不批量删除存量空页：在 1.9GB 真实库副本上一次性删除约 33 万行实测需 6–16 分钟，
 * 不能阻塞启动。存量空页在所属目标下一次接受空页时顺带清除，其余随终态目标的保留策略分批处理。
 */
export const historyEmptyCaptureMigration=(version:number):StorageMigration=>({version,sql:`
CREATE INDEX sync_capture_goal ON sync_capture(owner_id,goal_id);
`});

/**
 * capture_record 指向 sync_capture 的外键 (owner_id, contact_id, capture_id) 此前没有子表索引：
 * 每删除一行 sync_capture，外键检查都要全表扫描 capture_record（真实库约 18.5 万行，
 * 在副本上删除 50 个目标要 29 秒）。补上索引后删除空页与清理旧目标都只需索引查找。
 */
export const historyCaptureRecordForeignKeyIndexMigration=(version:number):StorageMigration=>({version,sql:`
CREATE INDEX capture_record_capture ON capture_record(owner_id,contact_id,capture_id);
`});

/**
 * 删除闭包按 (owner_id, message_id) 反查 message_alias：此前只能落在 (owner_id,…) 外键唯一索引前缀上，
 * 等于每条被删消息扫描整个 owner 分区（计划/清空/来源围栏三个调用点都在这次路径上，
 * 见 deletion.ts 的 idsForScope 反查；真实库 36.6 万行别名在联系人删除时实测占据一分钟级开销）。
 * 迁移只建索引不改数据；删除计划的目标集合与顺序不变。
 */
export const historyMessageAliasIndexMigration=(version:number):StorageMigration=>({version,sql:`
CREATE INDEX message_alias_message ON message_alias(owner_id,message_id);
`});
