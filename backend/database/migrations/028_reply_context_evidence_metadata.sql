BEGIN;

-- ReplyContext 快照保留每项证据的状态、有效期和 L1 revision，供生成前后
-- 重新验证；这些字段只保存最小元数据，不复制额外聊天内容。
ALTER TABLE public.reply_context_evidence
    ADD COLUMN IF NOT EXISTS evidence_status text NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS evidence_valid_at timestamptz,
    ADD COLUMN IF NOT EXISTS evidence_invalid_at timestamptz,
    ADD COLUMN IF NOT EXISTS evidence_revision integer;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.reply_context_evidence'::regclass
          AND conname = 'reply_context_evidence_revision_check'
    ) THEN
        ALTER TABLE public.reply_context_evidence
            ADD CONSTRAINT reply_context_evidence_revision_check
            CHECK (evidence_revision IS NULL OR evidence_revision >= 1);
    END IF;
END
$$;

COMMENT ON COLUMN public.reply_context_evidence.evidence_status IS
    '本轮快照读取时的证据状态；后续校验仍以权威存储为准。';
COMMENT ON COLUMN public.reply_context_evidence.evidence_valid_at IS
    '本轮快照读取时证据的生效时间。';
COMMENT ON COLUMN public.reply_context_evidence.evidence_invalid_at IS
    '本轮快照读取时证据的失效时间。';
COMMENT ON COLUMN public.reply_context_evidence.evidence_revision IS
    '关系记忆证据在本轮读取时的版本号。';

COMMIT;
