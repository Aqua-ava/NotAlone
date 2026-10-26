BEGIN;

CREATE TABLE public.assistant_session (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    is_default boolean NOT NULL DEFAULT TRUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE,
    UNIQUE (id, owner_id, contact_id)
);

CREATE UNIQUE INDEX assistant_session_default_scope_idx
    ON public.assistant_session (owner_id, contact_id) WHERE is_default;

CREATE TABLE public.assistant_session_turn (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    input_version_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    idempotency_key uuid NOT NULL,
    conversation_binding_id uuid NOT NULL,
    input_digest text CHECK (input_digest IS NULL OR input_digest ~ '^[0-9a-f]{64}$'),
    input_payload jsonb CHECK (input_payload IS NULL OR jsonb_typeof(input_payload) = 'object'),
    state text NOT NULL DEFAULT 'running'
        CHECK (state IN ('running', 'completed', 'failed', 'redacted')),
    reply_request_id uuid REFERENCES public.reply_request(id) ON DELETE SET NULL,
    dependency_ids uuid[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (session_id, owner_id, contact_id)
        REFERENCES public.assistant_session(id, owner_id, contact_id) ON DELETE CASCADE,
    UNIQUE (owner_id, contact_id, idempotency_key),
    CHECK ((state = 'redacted' AND input_payload IS NULL AND input_digest IS NULL
            AND reply_request_id IS NULL AND cardinality(dependency_ids) = 0)
           OR (state <> 'redacted' AND input_payload IS NOT NULL AND input_digest IS NOT NULL))
);

CREATE INDEX assistant_session_turn_order_idx
    ON public.assistant_session_turn (owner_id, contact_id, session_id, created_at, id);
CREATE INDEX assistant_session_turn_dependencies_idx
    ON public.assistant_session_turn USING gin (dependency_ids);

COMMENT ON TABLE public.assistant_session IS
    '已确认联系人范围内的持续助手讨论；默认会话不按昵称或空闲时间归并。';
COMMENT ON TABLE public.assistant_session_turn IS
    '稳定输入版本及既有回复请求关联；不复制候选正文，来源删除保留无正文占位。';
COMMENT ON COLUMN public.assistant_session_turn.dependency_ids IS
    '实际使用的全部上下文和前序候选的传递来源标识，仅用于失效与清除。';

COMMIT;
