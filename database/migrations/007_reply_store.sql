BEGIN;

CREATE TABLE public.reply_request (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    conversation_binding_id uuid NOT NULL,
    idempotency_key uuid NOT NULL,
    normalized_input text NOT NULL
        CHECK (length(btrim(normalized_input)) > 0),
    state text NOT NULL
        CHECK (state IN ('running', 'failed', 'expired', 'completed')),
    attempt integer NOT NULL CHECK (attempt >= 1),
    lease_expires_at timestamptz NOT NULL,
    continued_from_candidate_id uuid,
    context_snapshot jsonb
        CHECK (context_snapshot IS NULL OR jsonb_typeof(context_snapshot) = 'object'),
    skill_library_revision integer
        CHECK (skill_library_revision IS NULL OR skill_library_revision >= 0),
    skill_id uuid,
    skill_version_id uuid,
    skill_name text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE,
    UNIQUE (owner_id, contact_id, idempotency_key),
    UNIQUE (id, owner_id, contact_id, conversation_binding_id),
    CHECK (
        (skill_id IS NULL AND skill_version_id IS NULL AND skill_name IS NULL)
        OR (
            skill_id IS NOT NULL
            AND skill_version_id IS NOT NULL
            AND skill_name IS NOT NULL
            AND length(btrim(skill_name)) > 0
        )
    ),
    CHECK (
        state <> 'completed'
        OR (context_snapshot IS NOT NULL AND skill_library_revision IS NOT NULL)
    )
);

CREATE TABLE public.reply_attempt (
    reply_request_id uuid NOT NULL,
    number integer NOT NULL CHECK (number >= 1),
    state text NOT NULL
        CHECK (state IN ('running', 'failed', 'expired', 'completed')),
    started_at timestamptz NOT NULL,
    lease_expires_at timestamptz NOT NULL,
    failure_reason text
        CHECK (
            failure_reason IS NULL
            OR (
                length(failure_reason) BETWEEN 1 AND 64
                AND failure_reason !~ '[[:space:]]'
            )
        ),
    PRIMARY KEY (reply_request_id, number),
    FOREIGN KEY (reply_request_id)
        REFERENCES public.reply_request(id) ON DELETE CASCADE
);

CREATE TABLE public.reply_context_evidence (
    reply_request_id uuid NOT NULL,
    evidence_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    conversation_binding_id uuid NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    kind text NOT NULL
        CHECK (kind IN (
            'message',
            'confirmed_memory',
            'user_draft',
            'continued_candidate'
        )),
    evidence_text text NOT NULL CHECK (length(btrim(evidence_text)) > 0),
    source_ids jsonb NOT NULL
        CHECK (jsonb_typeof(source_ids) = 'array'),
    selection_reason text NOT NULL DEFAULT '',
    PRIMARY KEY (reply_request_id, evidence_id),
    UNIQUE (reply_request_id, ordinal),
    FOREIGN KEY (
        reply_request_id,
        owner_id,
        contact_id,
        conversation_binding_id
    ) REFERENCES public.reply_request(
        id,
        owner_id,
        contact_id,
        conversation_binding_id
    ) ON DELETE CASCADE
);

CREATE TABLE public.reply_candidate (
    id uuid PRIMARY KEY,
    reply_request_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    conversation_binding_id uuid NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    candidate_text text NOT NULL CHECK (length(btrim(candidate_text)) > 0),
    basis text NOT NULL CHECK (length(btrim(basis)) > 0),
    risk_notes jsonb NOT NULL
        CHECK (jsonb_typeof(risk_notes) = 'array'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (reply_request_id, id),
    UNIQUE (reply_request_id, ordinal),
    FOREIGN KEY (
        reply_request_id,
        owner_id,
        contact_id,
        conversation_binding_id
    ) REFERENCES public.reply_request(
        id,
        owner_id,
        contact_id,
        conversation_binding_id
    ) ON DELETE CASCADE
);

CREATE TABLE public.reply_candidate_citation (
    reply_request_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    evidence_id uuid NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    PRIMARY KEY (reply_request_id, candidate_id, ordinal),
    FOREIGN KEY (reply_request_id, candidate_id)
        REFERENCES public.reply_candidate(reply_request_id, id)
        ON DELETE CASCADE,
    FOREIGN KEY (reply_request_id, evidence_id)
        REFERENCES public.reply_context_evidence(reply_request_id, evidence_id)
        ON DELETE CASCADE
);

CREATE INDEX reply_request_contact_state_idx
    ON public.reply_request (owner_id, contact_id, state, updated_at DESC);

CREATE INDEX reply_attempt_request_idx
    ON public.reply_attempt (reply_request_id, number DESC);

CREATE INDEX reply_candidate_contact_created_idx
    ON public.reply_candidate (
        owner_id,
        contact_id,
        conversation_binding_id,
        created_at DESC
    );

COMMENT ON TABLE public.reply_request IS
    '已验证联系人范围内的候选回复请求、幂等状态和最小上下文快照。';
COMMENT ON COLUMN public.reply_request.owner_id IS
    '请求所属的 NotAlone 用户 UUID。';
COMMENT ON COLUMN public.reply_request.contact_id IS
    '请求所属的 NotAlone 联系人 UUID。';
COMMENT ON COLUMN public.reply_request.conversation_binding_id IS
    '外层验证通过的桌面会话绑定 UUID；ReplyStore 不负责验证绑定。';
COMMENT ON COLUMN public.reply_request.idempotency_key IS
    '同一 owner 与联系人范围内用于重放和重试的请求键。';
COMMENT ON COLUMN public.reply_request.normalized_input IS
    '不含私密异常正文的确定性输入规范化表示。';
COMMENT ON COLUMN public.reply_request.state IS
    '当前尝试状态：running、failed、expired 或 completed。';
COMMENT ON COLUMN public.reply_request.attempt IS
    '同一幂等请求的当前尝试序号；失败和租约过期时递增。';
COMMENT ON COLUMN public.reply_request.lease_expires_at IS
    '当前运行尝试的租约截止时间。';
COMMENT ON COLUMN public.reply_request.continued_from_candidate_id IS
    '用户显式选择后继续使用的前序候选 UUID。';
COMMENT ON COLUMN public.reply_request.context_snapshot IS
    '本次运行使用的最小上下文快照，不是可重新检索的长期事实。';
COMMENT ON COLUMN public.reply_request.skill_library_revision IS
    '本次上下文读取的 Skill 库修订号。';
COMMENT ON TABLE public.reply_attempt IS
    '候选回复请求的尝试和租约审计记录，不保存底层异常正文。';
COMMENT ON TABLE public.reply_context_evidence IS
    '候选回复实际使用的联系人范围证据快照和来源标识。';
COMMENT ON TABLE public.reply_candidate IS
    '候选回复文本、依据说明和风险提醒；不会自动发送到外部渠道。';
COMMENT ON TABLE public.reply_candidate_citation IS
    '候选回复到同一请求上下文证据的引用关系。';

COMMIT;
