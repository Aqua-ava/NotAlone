BEGIN;

-- 补齐记忆提取水位的级联删除：该表按 (owner_id, contact_id) 保存，
-- 但 012 创建时没有外键，owner 或 contact 被删除后水位行永久残留，
-- 且无任何产品路径可清理。与同期的 contact_memory_state/
-- contact_memory_index（018）的级联契约对齐。
-- 先清理既有孤儿行，避免给既有库加外键时失败。

DELETE FROM public.memory_extraction_watermark AS watermark
WHERE NOT EXISTS (
    SELECT 1
    FROM public.contact
    WHERE contact.owner_id = watermark.owner_id
      AND contact.id = watermark.contact_id
);

DELETE FROM public.memory_extraction_watermark AS watermark
WHERE NOT EXISTS (
    SELECT 1 FROM public.owner WHERE owner.id = watermark.owner_id
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname
            = 'memory_extraction_watermark_owner_id_contact_id_fkey'
          AND conrelid = 'public.memory_extraction_watermark'::regclass
    ) THEN
        ALTER TABLE public.memory_extraction_watermark
            ADD FOREIGN KEY (owner_id, contact_id)
            REFERENCES public.contact(owner_id, id) ON DELETE CASCADE;
    END IF;
END $$;

COMMIT;
