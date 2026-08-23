BEGIN;

-- 为 CLI 前台会话绑定补充匹配证据字段：
-- display_name 映射、选中会话元数据摘要和可选备用视觉指纹摘要。
-- 证据字段只用于会话定位与一次性确认，不保存聊天正文。
-- 迁移保持幂等：重复执行不会报错，也不会改变已有数据。
ALTER TABLE public.conversation_binding
    ADD COLUMN IF NOT EXISTS display_name text,
    ADD COLUMN IF NOT EXISTS metadata_summary jsonb,
    ADD COLUMN IF NOT EXISTS visual_fingerprint text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'conversation_binding_display_name_nonempty'
    ) THEN
        ALTER TABLE public.conversation_binding
            ADD CONSTRAINT conversation_binding_display_name_nonempty
                CHECK (display_name IS NULL OR length(btrim(display_name)) > 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'conversation_binding_metadata_summary_object'
    ) THEN
        ALTER TABLE public.conversation_binding
            ADD CONSTRAINT conversation_binding_metadata_summary_object
                CHECK (metadata_summary IS NULL OR jsonb_typeof(metadata_summary) = 'object');
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'conversation_binding_visual_fingerprint_nonempty'
    ) THEN
        ALTER TABLE public.conversation_binding
            ADD CONSTRAINT conversation_binding_visual_fingerprint_nonempty
                CHECK (visual_fingerprint IS NULL OR length(btrim(visual_fingerprint)) > 0);
    END IF;
END
$$;

COMMENT ON COLUMN public.conversation_binding.display_name IS
    '绑定时确认的外部会话展示名称映射；改名需用户再次确认后更新。';
COMMENT ON COLUMN public.conversation_binding.metadata_summary IS
    '左侧选中会话行的匹配证据摘要，如时间文本和预览摘要哈希；不保存预览原文。';
COMMENT ON COLUMN public.conversation_binding.visual_fingerprint IS
    '可选的头像视觉指纹摘要；仅在元数据无法区分时作为备用证据。';

COMMIT;
