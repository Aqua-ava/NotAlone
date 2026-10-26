BEGIN;

-- 重排任务会重置尝试次数；独立领取代次防止旧结果冒充新一轮租约。
ALTER TABLE public.background_task_step
    ADD COLUMN lease_generation bigint NOT NULL DEFAULT 0
    CHECK (lease_generation >= 0);

COMMENT ON COLUMN public.background_task_step.lease_generation IS
    '每次领取递增，续期及任务重排不重置；与范围、Worker 和有效期共同验证租约。';

COMMIT;
