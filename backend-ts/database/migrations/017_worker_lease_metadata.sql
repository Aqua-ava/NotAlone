BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'background_task_step'
          AND column_name = 'lease_owner'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'background_task_step'
          AND column_name = 'worker_id'
    ) THEN
        ALTER TABLE public.background_task_step
            RENAME COLUMN lease_owner TO worker_id;
    END IF;
END
$$;

ALTER TABLE public.background_task
    ADD COLUMN IF NOT EXISTS model_version text,
    ADD COLUMN IF NOT EXISTS rule_version text;

COMMENT ON COLUMN public.background_task_step.worker_id IS
    '当前步骤租约所属的内部 Worker UUID。';
COMMENT ON COLUMN public.background_task_step.lease_expires_at IS
    '当前步骤租约截止时间；过期后可由其他 Worker 接管。';
COMMENT ON COLUMN public.background_task.model_version IS
    '本次语义处理使用的模型版本标识，不保存模型输入输出。';
COMMENT ON COLUMN public.background_task.rule_version IS
    '本次确定性提取与采纳规则版本标识。';

COMMIT;
