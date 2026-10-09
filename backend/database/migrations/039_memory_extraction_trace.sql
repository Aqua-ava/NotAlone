BEGIN;

-- 追踪元数据不含正文；敏感阶段快照独立保存并支持整批清除。
CREATE TABLE public.memory_extraction_trace (
    trace_id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    run_id uuid NOT NULL,
    batch_key text NOT NULL,
    retry_of uuid,
    status text NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'succeeded', 'model_failed', 'skipped', 'trace_failed', 'business_failed', 'deleted')),
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    failure_stage text,
    error_code text,
    deletion_reason text,
    UNIQUE (trace_id, owner_id, contact_id),
    FOREIGN KEY (owner_id, contact_id) REFERENCES public.contact(owner_id, id) ON DELETE CASCADE
);
CREATE INDEX memory_extraction_trace_scope_idx
    ON public.memory_extraction_trace(owner_id, contact_id, started_at DESC);
CREATE INDEX memory_extraction_trace_batch_idx
    ON public.memory_extraction_trace(owner_id, contact_id, batch_key, started_at DESC);

CREATE TABLE public.memory_extraction_trace_event (
    event_id uuid PRIMARY KEY,
    trace_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    position integer NOT NULL,
    stage text NOT NULL,
    candidate_trace_id uuid,
    call_id uuid,
    payload jsonb NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (trace_id, position),
    FOREIGN KEY (trace_id, owner_id, contact_id)
        REFERENCES public.memory_extraction_trace(trace_id, owner_id, contact_id) ON DELETE CASCADE
);

-- 标识关联保留非正文计划与提交状态，手动删追踪仍能说明追溯缺失。
CREATE TABLE public.memory_extraction_trace_link (
    trace_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    candidate_trace_id uuid,
    record_kind text NOT NULL CHECK (record_kind IN ('candidate', 'contact_memory', 'owner_memory')),
    record_id uuid NOT NULL,
    commit_status text NOT NULL CHECK (commit_status IN ('planned', 'committed', 'unknown')),
    PRIMARY KEY (trace_id, record_kind, record_id),
    FOREIGN KEY (trace_id, owner_id, contact_id)
        REFERENCES public.memory_extraction_trace(trace_id, owner_id, contact_id) ON DELETE CASCADE
);
CREATE INDEX memory_extraction_trace_record_idx
    ON public.memory_extraction_trace_link(owner_id, contact_id, record_kind, record_id);

-- 来源可能来自参与判断的本人记忆，不把依赖错误地限于当前 contact_id。
CREATE TABLE public.memory_extraction_trace_dependency (
    trace_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    source_id uuid NOT NULL,
    PRIMARY KEY (trace_id, source_id),
    FOREIGN KEY (trace_id, owner_id, contact_id)
        REFERENCES public.memory_extraction_trace(trace_id, owner_id, contact_id) ON DELETE CASCADE
);
CREATE INDEX memory_extraction_trace_source_idx
    ON public.memory_extraction_trace_dependency(owner_id, source_id);

COMMENT ON TABLE public.memory_extraction_trace_event IS '记忆提取的敏感输入、输出和规则快照；不进入普通日志或最小出站台账。';
COMMENT ON TABLE public.memory_extraction_trace_dependency IS '全部窗口与所用旧记忆的来源依赖，删除任一来源时整批清除追踪正文。';
COMMIT;
