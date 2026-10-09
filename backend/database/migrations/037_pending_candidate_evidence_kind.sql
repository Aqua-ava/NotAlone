BEGIN;

-- 待确认候选以独立证据类型进入回复上下文（ADR-035）：只允许带强制
-- 「未确认」标注作为参考，不得当作确定事实，也不得混入已确认记忆集合。
-- 下面的 kind 列表必须与 src/notalone/reply/context.py 的 EVIDENCE_KINDS
-- 逐项一致：四处 Python 白名单都引用那个常量，SQL 无法引用 Python 常量，
-- 因此这里保持独立手写并由 tests/unit/reply/test_evidence_contract.py 核对。
ALTER TABLE public.reply_context_evidence
    DROP CONSTRAINT IF EXISTS reply_context_evidence_kind_check;

ALTER TABLE public.reply_context_evidence
    ADD CONSTRAINT reply_context_evidence_kind_check
    CHECK (kind IN (
        'message',
        'confirmed_memory',
        'owner_memory',
        'user_draft',
        'continued_candidate',
        'pending_candidate'
    ));

COMMENT ON COLUMN public.reply_context_evidence.kind IS
    '证据类型；pending_candidate 表示用户尚未确认、只能作为未确认参考的候选。';

COMMIT;
