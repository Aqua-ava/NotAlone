BEGIN;

CREATE TABLE public.outbound_ledger_entry (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    provider text NOT NULL CHECK (length(btrim(provider)) > 0),
    model_name text NOT NULL CHECK (length(btrim(model_name)) > 0),
    input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
    latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
    outcome text NOT NULL CHECK (outcome IN (
        'succeeded',
        'run_failed',
        'rejected_by_validation'
    )),
    called_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.outbound_ledger_entry IS
    '外部模型调用出站台账：最小操作记录，只含元数据不含正文；'
    '不与联系人或来源建立外键，删除联系人不级联清除历史条目。';

CREATE INDEX outbound_ledger_entry_owner_called_at_idx
    ON public.outbound_ledger_entry (owner_id, called_at);

COMMIT;
