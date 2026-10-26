BEGIN;

-- 本人资料修正保留同 owner 的旧版引用；不新增业务表或改写既有正文。
ALTER TABLE public.owner_memory
    ADD COLUMN IF NOT EXISTS supersedes_memory_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS owner_memory_owner_id_uidx
    ON public.owner_memory (owner_id, id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.owner_memory'::regclass
          AND conname = 'owner_memory_supersedes_fk'
    ) THEN
        ALTER TABLE public.owner_memory
            ADD CONSTRAINT owner_memory_supersedes_fk
            FOREIGN KEY (owner_id, supersedes_memory_id)
            REFERENCES public.owner_memory(owner_id, id)
            ON DELETE SET NULL (supersedes_memory_id);
    END IF;
END
$$;

ALTER TABLE public.owner_memory
    DROP CONSTRAINT IF EXISTS owner_memory_supersedes_self_check;
ALTER TABLE public.owner_memory
    ADD CONSTRAINT owner_memory_supersedes_self_check
    CHECK (supersedes_memory_id IS NULL OR supersedes_memory_id <> id);

COMMENT ON COLUMN public.owner_memory.supersedes_memory_id IS
    '本人手动修正产生的新版本所替代的同 owner 旧记忆 ID。';

COMMIT;
