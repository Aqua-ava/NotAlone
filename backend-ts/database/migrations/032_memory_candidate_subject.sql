BEGIN;

-- 候选必须跨过 pending 边界保留事实主体，否则 self 事实在人工确认时
-- 会被错误写入当前联系人的关系记忆。
ALTER TABLE public.memory_candidate
    ADD COLUMN IF NOT EXISTS subject text NOT NULL DEFAULT 'contact';

ALTER TABLE public.memory_candidate
    DROP CONSTRAINT IF EXISTS memory_candidate_subject_check;
ALTER TABLE public.memory_candidate
    ADD CONSTRAINT memory_candidate_subject_check
    CHECK (subject IN ('self', 'contact', 'shared'));

-- owner 记忆保留来源候选，以便确认请求可以安全重试并返回同一结果。
ALTER TABLE public.owner_memory
    ADD COLUMN IF NOT EXISTS source_candidate_id uuid;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.owner_memory'::regclass
          AND conname = 'owner_memory_source_candidate_fk'
    ) THEN
        ALTER TABLE public.owner_memory
            ADD CONSTRAINT owner_memory_source_candidate_fk
            FOREIGN KEY (source_candidate_id)
            REFERENCES public.memory_candidate(id)
            ON DELETE SET NULL;
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS owner_memory_source_candidate_uidx
    ON public.owner_memory (owner_id, source_candidate_id)
    WHERE source_candidate_id IS NOT NULL;

COMMENT ON COLUMN public.memory_candidate.subject IS
    '候选事实主体：self、contact 或 shared；人工确认必须据此选择 owner/contact 记忆。';
COMMENT ON COLUMN public.owner_memory.source_candidate_id IS
    '产生该 owner 记忆的 self 候选 UUID；用于确认幂等与来源审计。';

COMMIT;
