BEGIN;

-- 增量观察按联系人复用一个可恢复的后台记忆任务；它不绑定历史来源文件。
ALTER TABLE public.background_task
    ALTER COLUMN source_document_id DROP NOT NULL;

ALTER TABLE public.background_task
    ADD COLUMN observation_pending boolean NOT NULL DEFAULT false;

ALTER TABLE public.background_task
    DROP CONSTRAINT IF EXISTS background_task_task_type_check;
ALTER TABLE public.background_task
    ADD CONSTRAINT background_task_task_type_check
    CHECK (task_type IN ('import', 'delete', 'observation'));

ALTER TABLE public.background_task
    ADD CONSTRAINT background_task_observation_source_check
    CHECK (
        (task_type = 'observation' AND source_document_id IS NULL)
        OR (task_type IN ('import', 'delete') AND source_document_id IS NOT NULL)
    );

CREATE UNIQUE INDEX IF NOT EXISTS background_task_observation_scope_unique
    ON public.background_task (owner_id, contact_id)
    WHERE task_type = 'observation';

COMMENT ON COLUMN public.background_task.source_document_id IS
    '历史导入或来源删除任务的来源 UUID；联系人级 observation 任务为空。';
COMMENT ON COLUMN public.background_task.observation_pending IS
    '观察任务运行中收到新可靠批次时置 true；本轮完成后重新排队，不丢失下一轮唤醒。';

COMMIT;
