BEGIN;

-- 记忆召回第一期：本人记忆以独立证据类型进入回复上下文。
ALTER TABLE public.reply_context_evidence
    DROP CONSTRAINT IF EXISTS reply_context_evidence_kind_check;

ALTER TABLE public.reply_context_evidence
    ADD CONSTRAINT reply_context_evidence_kind_check
    CHECK (kind IN (
        'message',
        'confirmed_memory',
        'owner_memory',
        'user_draft',
        'continued_candidate'
    ));

COMMIT;
