BEGIN;

-- 来源删除复用固定步骤、租约和重试；保留无正文调用台账。
ALTER TABLE public.background_task DROP CONSTRAINT background_task_task_type_check;
ALTER TABLE public.background_task ADD CONSTRAINT background_task_task_type_check
    CHECK (task_type IN ('import', 'delete'));
ALTER TABLE public.background_task DROP CONSTRAINT background_task_current_step_check;
ALTER TABLE public.background_task ADD CONSTRAINT background_task_current_step_check
    CHECK (current_step IN ('parse', 'normalize', 'extract_memory', 'index', 'verify',
        'mark_deleted', 'delete_derived', 'delete_index', 'clear_cache', 'verify_not_retrievable'));
ALTER TABLE public.background_task_step DROP CONSTRAINT background_task_step_step_name_check;
ALTER TABLE public.background_task_step ADD CONSTRAINT background_task_step_step_name_check
    CHECK (step_name IN ('parse', 'normalize', 'extract_memory', 'index', 'verify',
        'mark_deleted', 'delete_derived', 'delete_index', 'clear_cache', 'verify_not_retrievable'));

COMMIT;
