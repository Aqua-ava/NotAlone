BEGIN;

ALTER TABLE public.reply_skill ADD COLUMN directory_managed boolean NOT NULL DEFAULT false;
ALTER TABLE public.reply_skill_version
    ADD COLUMN content_path text,
    ADD COLUMN document_sha256 text CHECK (document_sha256 IS NULL OR document_sha256 ~ '^[0-9a-f]{64}$'),
    ADD COLUMN directory_available boolean NOT NULL DEFAULT true;

-- 保留旧字节直到落盘校验成功；新的发布仅写目录定位。
DO $$ DECLARE constraint_name text; BEGIN
    FOR constraint_name IN
        SELECT conname FROM pg_constraint
        WHERE conrelid='public.reply_skill_version'::regclass AND contype='c'
          AND pg_get_constraintdef(oid) LIKE '%content IS NOT NULL%'
    LOOP
        EXECUTE format('ALTER TABLE public.reply_skill_version DROP CONSTRAINT %I', constraint_name);
    END LOOP;
END $$;
ALTER TABLE public.reply_skill_version ADD CONSTRAINT reply_skill_version_storage_check CHECK (
    (status='active' AND deleted_at IS NULL AND
        ((content IS NOT NULL AND length(btrim(content))>0) OR
         (content_path IS NOT NULL AND document_sha256 IS NOT NULL)))
    OR (status='deleted' AND deleted_at IS NOT NULL AND content IS NULL
        AND content_path IS NULL AND document_sha256 IS NULL AND source_locator IS NULL AND NOT enabled)
);

ALTER TABLE public.reply_skill_resource ALTER COLUMN content DROP NOT NULL;
ALTER TABLE public.reply_skill_resource ADD COLUMN content_path text;
ALTER TABLE public.reply_skill_resource ADD CONSTRAINT reply_skill_resource_storage_check
    CHECK (content IS NOT NULL OR content_path IS NOT NULL);

CREATE TABLE public.reply_skill_file_cleanup (
    relative_path text PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.reply_skill_working_copy (
    skill_id uuid PRIMARY KEY REFERENCES public.reply_skill(id) ON DELETE CASCADE,
    version_id uuid NOT NULL REFERENCES public.reply_skill_version(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN public.reply_skill_version.content_path IS '受控Skill根目录内不可变SKILL.md快照的相对路径；不接受任意文件路径。';
COMMENT ON TABLE public.reply_skill_file_cleanup IS '删除事务提交后的可重试文件清理；不保存正文，路径不可供运行时加载。';
COMMENT ON TABLE public.reply_skill_working_copy IS '已提交发布或回滚等待同步的可编辑目录；未提交内容不可被发现。';

COMMIT;
