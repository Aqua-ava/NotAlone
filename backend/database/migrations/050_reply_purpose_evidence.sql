BEGIN;

-- 主动联系目的独立于草稿和对方消息；与 reply/context.py 的 EVIDENCE_KINDS 保持一致。
ALTER TABLE public.reply_context_evidence
    DROP CONSTRAINT IF EXISTS reply_context_evidence_kind_check;
ALTER TABLE public.reply_context_evidence
    ADD CONSTRAINT reply_context_evidence_kind_check
    CHECK (kind IN ('message', 'confirmed_memory', 'owner_memory', 'user_draft',
                   'user_purpose', 'continued_candidate', 'pending_candidate'));

COMMIT;
