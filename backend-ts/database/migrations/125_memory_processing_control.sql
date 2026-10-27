BEGIN;
-- 控制回执只保存无正文动作身份；重放不能覆盖更新的用户意图。
CREATE TABLE public.memory_processing_operation (
 scope_id uuid NOT NULL REFERENCES public.memory_processing_scope(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('pause','continue')),
 action_version bigint NOT NULL CHECK(action_version>=0),
 accepted_generation bigint NOT NULL CHECK(accepted_generation>action_version),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(scope_id,operation_id)
);
-- 执行租约绑定领取时的范围代次，不能把暂停前结果用于继续后的工作。
ALTER TABLE public.background_task_step ADD COLUMN memory_control_generation bigint CHECK(memory_control_generation>=0);
COMMIT;
