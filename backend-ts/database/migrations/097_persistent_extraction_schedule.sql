-- 新提交观察的持久调度；不回填旧历史，不复制聊天正文。
CREATE TABLE public.memory_extraction_schedule (
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL,
    pending_count integer NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
    threshold integer NOT NULL DEFAULT 1 CHECK (threshold BETWEEN 1 AND 5),
    last_input_at timestamptz,
    due_at timestamptz,
    generation bigint NOT NULL DEFAULT 0,
    task_id uuid REFERENCES public.background_task(id) ON DELETE SET NULL,
    PRIMARY KEY(owner_id, contact_id),
    FOREIGN KEY(owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE
);
CREATE TABLE public.memory_extraction_receipt (
    message_id uuid PRIMARY KEY REFERENCES public.message(id) ON DELETE CASCADE,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    observation_id uuid NOT NULL REFERENCES public.local_wechat_observation(id) ON DELETE CASCADE,
    task_id uuid REFERENCES public.background_task(id) ON DELETE SET NULL,
    FOREIGN KEY(owner_id,contact_id) REFERENCES public.memory_extraction_schedule(owner_id,contact_id) ON DELETE CASCADE
);
CREATE INDEX extraction_schedule_due ON public.memory_extraction_schedule(owner_id,due_at) WHERE due_at IS NOT NULL;
