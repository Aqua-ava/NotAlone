BEGIN;

-- 逐版本迁移入口先把旧内容完整落盘并核验；本文件不读取或复制正文。
ALTER TABLE public.reply_skill_version ADD COLUMN IF NOT EXISTS manifest_sha256 text
    CHECK (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[0-9a-f]{64}$');

DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM public.reply_skill_version
        WHERE status='active' AND (content_path IS NULL OR document_sha256 IS NULL
            OR content_sha256 IS NULL OR manifest_sha256 IS NULL OR content IS NOT NULL)
    ) OR EXISTS (
        SELECT 1 FROM public.reply_skill_method AS method
        JOIN public.reply_skill_version AS version ON version.id=method.version_id
        WHERE version.status='active' AND (method.title IS NOT NULL OR method.instruction IS NOT NULL
            OR version.method_manifest_path IS NULL OR version.method_manifest_sha256 IS NULL)
    ) THEN
        RAISE EXCEPTION 'skill_content_upgrade_required';
    END IF;
END $$;

DROP TABLE public.reply_skill_resource;
ALTER TABLE public.reply_skill DROP COLUMN description, DROP COLUMN directory_managed;
ALTER TABLE public.reply_skill_version
    DROP COLUMN name, DROP COLUMN description, DROP COLUMN content,
    DROP COLUMN validation_warnings;
ALTER TABLE public.reply_skill_method DROP COLUMN title, DROP COLUMN instruction;

ALTER TABLE public.reply_skill_version ADD CONSTRAINT reply_skill_version_storage_check CHECK (
    (status='active' AND deleted_at IS NULL AND content_path IS NOT NULL
        AND document_sha256 IS NOT NULL AND content_sha256 IS NOT NULL AND manifest_sha256 IS NOT NULL)
    OR (status='deleted' AND deleted_at IS NOT NULL AND content_path IS NULL
        AND document_sha256 IS NULL AND manifest_sha256 IS NULL AND source_locator IS NULL AND NOT enabled)
);

COMMENT ON COLUMN public.reply_skill_version.manifest_sha256 IS
    '不可变版本根manifest.json的完整性哈希；描述、警告和资源索引只存文件。';
COMMENT ON TABLE public.reply_skill_method IS
    '只保存方法身份、顺序与延续映射；标题及指令由不可变方法文件按需提供。';

COMMIT;
