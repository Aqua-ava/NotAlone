-- 110 草案：由主会话在共享迁移窗口落盘；不改写010或既有台账UUID。
BEGIN;
CREATE TABLE public.model_call_receipt (
    attempt_id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    contact_id uuid,
    scope_kind text NOT NULL DEFAULT 'contact' CHECK (scope_kind IN ('contact','owner_memory')),
    request_id uuid NOT NULL,
    permit_id uuid NOT NULL,
    ledger_entry_id uuid UNIQUE REFERENCES public.outbound_ledger_entry(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (length(btrim(provider)) > 0),
    model_name text NOT NULL CHECK (length(btrim(model_name)) > 0),
    called_at timestamptz NOT NULL,
    input_budget jsonb,
    latency_ms integer CHECK (latency_ms >= 0),
    dispatch text NOT NULL CHECK (dispatch IN ('authorized_unconfirmed','response_observed','http_accepted','not_sent')),
    outcome text NOT NULL CHECK (outcome IN ('pending','succeeded','failed','cancelled','unknown')),
    input_tokens integer CHECK (input_tokens >= 0),
    output_tokens integer CHECK (output_tokens >= 0),
    cache_read_tokens integer CHECK (cache_read_tokens >= 0),
    cache_write_tokens integer CHECK (cache_write_tokens >= 0),
    cost_status text NOT NULL CHECK (cost_status IN ('unknown','estimated','known')),
    cost_amount numeric CHECK (cost_amount >= 0),
    currency text,
    pricing_version text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE,
    CHECK ((scope_kind='contact' AND contact_id IS NOT NULL) OR (scope_kind='owner_memory' AND contact_id IS NULL AND ledger_entry_id IS NULL)),
    CHECK (input_budget IS NULL OR ((
        jsonb_typeof(input_budget)='object'
        AND input_budget ?& ARRAY['measurement_id','measurement_kind','input_tokens','max_output_tokens','context_window_tokens','safety_margin_tokens','request_sha256','serialized_bytes']
        AND input_budget - ARRAY['measurement_id','measurement_kind','input_tokens','max_output_tokens','context_window_tokens','safety_margin_tokens','request_sha256','serialized_bytes']='{}'::jsonb
        AND jsonb_typeof(input_budget->'measurement_id')='string'
        AND input_budget->>'measurement_id' ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
        AND input_budget->>'measurement_kind'='approximate'
        AND input_budget->>'request_sha256' ~ '^[a-f0-9]{64}$'
        AND jsonb_typeof(input_budget->'input_tokens')='number' AND input_budget->>'input_tokens' ~ '^[1-9][0-9]*$'
        AND jsonb_typeof(input_budget->'max_output_tokens')='number' AND input_budget->>'max_output_tokens' ~ '^[1-9][0-9]*$'
        AND jsonb_typeof(input_budget->'context_window_tokens')='number' AND input_budget->>'context_window_tokens' ~ '^[1-9][0-9]*$'
        AND jsonb_typeof(input_budget->'safety_margin_tokens')='number' AND input_budget->>'safety_margin_tokens' ~ '^[1-9][0-9]*$'
        AND jsonb_typeof(input_budget->'serialized_bytes')='number' AND input_budget->>'serialized_bytes' ~ '^[1-9][0-9]*$'
    ) IS TRUE)),
    CHECK ((input_tokens IS NULL) = (output_tokens IS NULL)),
    CHECK (input_tokens IS NOT NULL OR (cache_read_tokens IS NULL AND cache_write_tokens IS NULL)),
    CHECK (coalesce(cache_read_tokens,0)+coalesce(cache_write_tokens,0) <= input_tokens),
    CHECK ((cost_status='unknown' AND cost_amount IS NULL AND currency IS NULL AND pricing_version IS NULL)
        OR (cost_status IN ('estimated','known') AND cost_amount IS NOT NULL AND currency IS NOT NULL AND pricing_version IS NOT NULL AND length(btrim(currency))>0 AND length(btrim(pricing_version))>0)),
    CHECK (outcome <> 'succeeded' OR dispatch IN ('response_observed','http_accepted'))
);
CREATE INDEX model_call_receipt_owner_permit ON public.model_call_receipt(owner_id,permit_id);
COMMENT ON TABLE public.model_call_receipt IS '模型物理尝试的非正文元数据；授权未确认不计作确认HTTP；未知不退款、不自动重放；旧ledger UUID保留。';
COMMIT;
