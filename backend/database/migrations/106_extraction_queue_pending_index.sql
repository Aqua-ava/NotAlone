BEGIN;

-- 历史同步按页写入提取回执：待认领查询只扫描本联系人尚未排队的行，
-- 不能随历史规模退化为全表扫描或拖慢同事务的历史页提交。
CREATE INDEX IF NOT EXISTS memory_extraction_receipt_pending_idx
    ON public.memory_extraction_receipt (owner_id, contact_id, observation_id)
    WHERE task_id IS NULL;

COMMENT ON INDEX public.memory_extraction_receipt_pending_idx IS
    '按联系人查找尚未排队的提取回执；历史同步按页入队时使用。';

COMMIT;
