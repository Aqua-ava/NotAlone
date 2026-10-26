BEGIN;

CREATE TABLE IF NOT EXISTS public.background_task (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    source_document_id uuid NOT NULL,
    task_type text NOT NULL CHECK (task_type IN ('import')),
    status text NOT NULL DEFAULT 'queued'
        CHECK (status IN (
            'queued',
            'running',
            'verifying',
            'succeeded',
            'failed',
            'cancelled'
        )),
    current_step text NOT NULL
        CHECK (current_step IN (
            'parse',
            'normalize',
            'extract_memory',
            'index',
            'verify'
        )),
    message_count integer NOT NULL CHECK (message_count >= 0),
    retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    last_error_code text,
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE,
    FOREIGN KEY (owner_id, contact_id, source_document_id)
        REFERENCES public.source_document(owner_id, contact_id, id)
        ON DELETE CASCADE,
    UNIQUE (owner_id, contact_id, source_document_id, task_type)
);

CREATE INDEX IF NOT EXISTS background_task_scope_status_idx
    ON public.background_task (owner_id, contact_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.background_task_step (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL
        REFERENCES public.background_task(id) ON DELETE CASCADE,
    step_name text NOT NULL CHECK (step_name IN (
        'parse',
        'normalize',
        'extract_memory',
        'index',
        'verify'
    )),
    step_order smallint NOT NULL CHECK (step_order BETWEEN 1 AND 5),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending',
            'running',
            'succeeded',
            'retryable',
            'failed',
            'cancelled'
        )),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    processed_count integer NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
    total_count integer CHECK (total_count IS NULL OR total_count >= 0),
    lease_owner uuid,
    lease_expires_at timestamptz,
    last_error_code text,
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (task_id, step_name),
    UNIQUE (task_id, step_order)
);

CREATE INDEX IF NOT EXISTS background_task_step_claim_idx
    ON public.background_task_step (status, lease_expires_at, step_order);

COMMENT ON TABLE public.background_task IS
    '按 owner、联系人和来源绑定的后台业务任务，只保存可恢复状态元数据。';
COMMENT ON COLUMN public.background_task.owner_id IS
    'NotAlone 内部 owner UUID；任务读取必须携带 owner 范围。';
COMMENT ON COLUMN public.background_task.contact_id IS
    'NotAlone 内部联系人 UUID；不使用微信外部 ID 替代。';
COMMENT ON COLUMN public.background_task.source_document_id IS
    '任务处理的内部来源 UUID；同一来源范围内只允许一个导入任务。';
COMMENT ON COLUMN public.background_task.message_count IS
    '该来源的规范消息数量，不保存消息正文。';
COMMENT ON COLUMN public.background_task.last_error_code IS
    '不含聊天正文或模型输入输出的稳定错误分类。';
COMMENT ON TABLE public.background_task_step IS
    '后台任务的固定、可恢复执行步骤，不保存聊天正文或模型完整输入输出。';
COMMENT ON COLUMN public.background_task_step.step_name IS
    '由系统控制的固定步骤名，不由模型创建、删除或重排。';
COMMENT ON COLUMN public.background_task_step.processed_count IS
    '步骤已处理的非正文数量。';
COMMENT ON COLUMN public.background_task_step.last_error_code IS
    '不含聊天正文或模型输入输出的稳定步骤错误分类。';

COMMIT;
