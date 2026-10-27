BEGIN;

-- 轮次保存目标身份快照；同一真实任务后续新增的目标不会被当前轮次继续消费。
CREATE TABLE public.memory_processing_round_target (
    round_id uuid NOT NULL,
    task_id uuid NOT NULL,
    message_id uuid NOT NULL,
    PRIMARY KEY(round_id,task_id,message_id),
    FOREIGN KEY(round_id,task_id)
        REFERENCES public.memory_processing_round_task(round_id,task_id) ON DELETE CASCADE,
    FOREIGN KEY(task_id,message_id)
        REFERENCES public.memory_processing_target(task_id,message_id) ON DELETE CASCADE
);

CREATE INDEX memory_processing_round_target_task
    ON public.memory_processing_round_target(task_id,message_id);

-- 已存在的当前有效归属按迁移时事实补快照，不根据完成结果猜测或补造目标。
INSERT INTO public.memory_processing_round_target(round_id,task_id,message_id)
SELECT member.round_id,target.task_id,target.message_id
FROM public.memory_processing_round_task member
JOIN public.memory_processing_round round ON round.id=member.round_id
JOIN public.memory_processing_scope control
    ON control.id=round.scope_id
    AND control.active_round_id=member.round_id
JOIN public.memory_processing_target target ON target.task_id=member.task_id
WHERE member.active
ON CONFLICT DO NOTHING;

COMMIT;
