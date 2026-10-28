BEGIN;

-- 旧任务无法核验时保留其原始身份与失败事实；当前增量观察需要独立任务，
-- 不能为了避开旧失败而重置旧任务或放弃后续聊天。
DROP INDEX IF EXISTS public.background_task_observation_scope_unique;

CREATE INDEX IF NOT EXISTS background_task_observation_scope_lookup
    ON public.background_task (owner_id, contact_id, created_at DESC)
    WHERE task_type = 'observation';

COMMENT ON INDEX public.background_task_observation_scope_lookup IS
    '增量观察按范围查找候选任务；旧隔离任务与当前任务可并存，领取资格由轮次归属控制。';

COMMIT;
