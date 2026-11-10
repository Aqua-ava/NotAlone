import type { StorageMigration } from '../contracts.ts';

/** 迁移48：已完成删除只保留操作级摘要，一次性清理存量逐行台账。
 *
 * 逐行 deletion_target 在操作 completed 后没有读者：领域回调经 claim 对 completed 拒绝，
 * 公开状态只返回操作级进度，保留只会让库体随历史删除无限增长。
 * 本迁移为全部 completed 操作补写按 domain+row_kind 汇总条数的 JSON 摘要（不含任何行键），
 * 再删除其逐行记录；未完成操作（fenced/cleaning/verifying/blocked）原样保留，行为不变。
 */
export const deletionLedgerPruneMigration = (version: number): StorageMigration => ({ version, sql: `
ALTER TABLE deletion_operation ADD COLUMN target_summary TEXT;
CREATE TEMP TABLE _deletion_target_summary AS
 SELECT operation_id, json_group_object(bucket, n) summary FROM (
  SELECT operation_id, domain || ':' || COALESCE(row_kind, 'file') bucket, COUNT(*) n
  FROM deletion_target GROUP BY operation_id, domain, COALESCE(row_kind, 'file'))
 GROUP BY operation_id;
UPDATE deletion_operation SET target_summary=(SELECT s.summary FROM _deletion_target_summary s WHERE s.operation_id=deletion_operation.operation_id) WHERE state='completed';
DROP TABLE _deletion_target_summary;
DELETE FROM deletion_target WHERE operation_id IN (SELECT operation_id FROM deletion_operation WHERE state='completed');
` });
