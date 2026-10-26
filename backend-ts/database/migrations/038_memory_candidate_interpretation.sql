BEGIN;

-- 备选解释与短理由是模型对候选的说明，保留在候选层供用户判断，
-- 不复制聊天正文，也不改变候选的确认状态或采纳门。
ALTER TABLE public.memory_candidate
    ADD COLUMN IF NOT EXISTS alternatives text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS interpretation_reason text;

COMMENT ON COLUMN public.memory_candidate.alternatives IS
    '候选存在歧义时的少量备选解释；为空表示模型未提供。';
COMMENT ON COLUMN public.memory_candidate.interpretation_reason IS
    '面向用户的简短语用判断依据；为空表示模型未提供。';

COMMIT;
