BEGIN;
-- 原110收据不重写；复合候选键仅用于把学习授权事实约束到同一真实范围与请求。
ALTER TABLE public.model_call_receipt ADD CONSTRAINT model_call_receipt_claim_scope_key
    UNIQUE (attempt_id, owner_id, contact_id, request_id);
ALTER TABLE public.background_task_step ADD CONSTRAINT background_task_step_claim_task_key
    UNIQUE (id, task_id);
CREATE TABLE public.model_call_learning_claim (
    attempt_id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    request_id uuid NOT NULL,
    task_id uuid NOT NULL,
    step_id uuid NOT NULL,
    step_name text NOT NULL CHECK (step_name='propose_skill'),
    worker_id uuid NOT NULL,
    lease_generation bigint NOT NULL CHECK (lease_generation>0),
    UNIQUE (step_id,lease_generation),
    FOREIGN KEY (attempt_id,owner_id,contact_id,request_id)
        REFERENCES public.model_call_receipt(attempt_id,owner_id,contact_id,request_id) ON DELETE CASCADE,
    FOREIGN KEY (task_id,owner_id,contact_id)
        REFERENCES public.background_task(id,owner_id,contact_id) ON DELETE CASCADE,
    FOREIGN KEY (step_id,task_id)
        REFERENCES public.background_task_step(id,task_id) ON DELETE CASCADE
);
COMMENT ON TABLE public.model_call_learning_claim IS
    '无正文学习物理调用授权；每真实任务租约一次，原失败重试及显式恢复不清累计收据，未知不得重放。';
COMMIT;
