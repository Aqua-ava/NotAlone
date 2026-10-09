BEGIN;

ALTER TABLE public.memory_extraction_trace
    DROP CONSTRAINT memory_extraction_trace_status_check;
ALTER TABLE public.memory_extraction_trace
    ADD CONSTRAINT memory_extraction_trace_status_check
    CHECK (status IN ('running', 'succeeded', 'model_failed', 'skipped', 'trace_failed', 'business_failed', 'stopped', 'scope_invalidated', 'scope_guard_failed', 'deleted'));

-- 最小调用关联不含正文；删除来源后仍能说明实际调用与丢弃结果。
CREATE TABLE public.memory_extraction_trace_call (
    call_id uuid PRIMARY KEY,
    trace_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    purpose text NOT NULL CHECK (purpose IN ('extraction', 'verification', 'adjudication')),
    called_at timestamptz NOT NULL,
    finished_at timestamptz,
    response_status text NOT NULL CHECK (response_status IN ('returned', 'received', 'unavailable')),
    provider_attempts integer NOT NULL CHECK (provider_attempts >= 0),
    ledger_entry_id uuid NOT NULL,
    ledger_commit_status text NOT NULL CHECK (ledger_commit_status IN ('committed', 'unknown')),
    disposition text NOT NULL CHECK (disposition IN ('consumed', 'not_adopted')),
    FOREIGN KEY (trace_id, owner_id, contact_id)
        REFERENCES public.memory_extraction_trace(trace_id, owner_id, contact_id) ON DELETE CASCADE
);
CREATE INDEX memory_extraction_trace_call_trace_idx ON public.memory_extraction_trace_call(trace_id, called_at, call_id);
COMMENT ON TABLE public.memory_extraction_trace_call IS '实际模型调用的最小无正文台账关联；来源或追踪正文删除不删除此关联。';

COMMIT;
