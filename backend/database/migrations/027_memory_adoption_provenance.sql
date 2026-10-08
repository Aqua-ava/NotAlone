BEGIN;

-- 提取候选保留采纳裁决所需的置信度、风险和失败原因，避免生成阶段的
-- 证据在进入 pending/confirmed 后丢失。
ALTER TABLE public.memory_candidate
    ADD COLUMN IF NOT EXISTS confidence double precision NOT NULL DEFAULT 1.0,
    ADD COLUMN IF NOT EXISTS risk_flags text[] NOT NULL DEFAULT ARRAY[]::text[],
    ADD COLUMN IF NOT EXISTS failure_reason text;

ALTER TABLE public.memory_candidate
    DROP CONSTRAINT IF EXISTS memory_candidate_status_check;
ALTER TABLE public.memory_candidate
    ADD CONSTRAINT memory_candidate_status_check
    CHECK (status IN (
        'pending',
        'confirmed',
        'rejected',
        'invalidated',
        'extract_failed'
    ));

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.memory_candidate'::regclass
          AND conname = 'memory_candidate_confidence_check'
    ) THEN
        ALTER TABLE public.memory_candidate
            ADD CONSTRAINT memory_candidate_confidence_check
            CHECK (confidence >= 0.0 AND confidence <= 1.0);
    END IF;
END
$$;

ALTER TABLE public.memory_candidate
    DROP CONSTRAINT IF EXISTS memory_candidate_extract_failure_check;
ALTER TABLE public.memory_candidate
    ADD CONSTRAINT memory_candidate_extract_failure_check
    CHECK (
        status <> 'extract_failed'
        OR length(btrim(coalesce(failure_reason, ''))) > 0
    );

-- 已确认记忆同样携带原始采纳信息；修正通过新行形成版本链，旧行只保留
-- invalidated 审计状态，避免静默覆盖用户看到过的内容。
ALTER TABLE public.confirmed_memory
    ADD COLUMN IF NOT EXISTS confidence double precision NOT NULL DEFAULT 1.0,
    ADD COLUMN IF NOT EXISTS risk_flags text[] NOT NULL DEFAULT ARRAY[]::text[],
    ADD COLUMN IF NOT EXISTS supersedes_memory_id uuid;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.confirmed_memory'::regclass
          AND conname = 'confirmed_memory_confidence_check'
    ) THEN
        ALTER TABLE public.confirmed_memory
            ADD CONSTRAINT confirmed_memory_confidence_check
            CHECK (confidence >= 0.0 AND confidence <= 1.0);
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.confirmed_memory'::regclass
          AND conname = 'confirmed_memory_supersedes_fk'
    ) THEN
        ALTER TABLE public.confirmed_memory
            ADD CONSTRAINT confirmed_memory_supersedes_fk
            FOREIGN KEY (owner_id, contact_id, supersedes_memory_id)
            REFERENCES public.confirmed_memory(owner_id, contact_id, id)
            ON DELETE SET NULL;
    END IF;
END
$$;

ALTER TABLE public.confirmed_memory
    DROP CONSTRAINT IF EXISTS confirmed_memory_supersedes_self_check;
ALTER TABLE public.confirmed_memory
    ADD CONSTRAINT confirmed_memory_supersedes_self_check
    CHECK (supersedes_memory_id IS NULL OR supersedes_memory_id <> id);

ALTER TABLE public.owner_memory
    ADD COLUMN IF NOT EXISTS confidence double precision NOT NULL DEFAULT 1.0,
    ADD COLUMN IF NOT EXISTS risk_flags text[] NOT NULL DEFAULT ARRAY[]::text[];

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.owner_memory'::regclass
          AND conname = 'owner_memory_confidence_check'
    ) THEN
        ALTER TABLE public.owner_memory
            ADD CONSTRAINT owner_memory_confidence_check
            CHECK (confidence >= 0.0 AND confidence <= 1.0);
    END IF;
END
$$;

COMMENT ON COLUMN public.memory_candidate.confidence IS
    '结构化提取候选的置信度；用于人工确认门槛，不代表用户确认。';
COMMENT ON COLUMN public.memory_candidate.risk_flags IS
    '结构化提取候选的风险标签；未知或敏感标签不得自动采纳。';
COMMENT ON COLUMN public.memory_candidate.failure_reason IS
    '提取失败候选的可审计原因；正常 pending 候选为空。';
COMMENT ON COLUMN public.confirmed_memory.confidence IS
    '进入 confirmed_memory 时保留的提取置信度。';
COMMENT ON COLUMN public.confirmed_memory.risk_flags IS
    '进入 confirmed_memory 时保留的提取风险标签。';
COMMENT ON COLUMN public.confirmed_memory.supersedes_memory_id IS
    '手动修正形成的新版本所替代的旧记忆 ID。';

COMMIT;
