BEGIN;

ALTER TABLE public.reply_skill_version
    ADD COLUMN IF NOT EXISTS validation_warnings jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(validation_warnings) = 'array');

CREATE TABLE IF NOT EXISTS public.reply_skill_resource (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_version_id uuid NOT NULL
        REFERENCES public.reply_skill_version(id) ON DELETE CASCADE,
    relative_path text NOT NULL
        CHECK (length(btrim(relative_path)) > 0),
    resource_kind text NOT NULL
        CHECK (resource_kind IN ('reference', 'asset')),
    media_type text NOT NULL
        CHECK (length(btrim(media_type)) > 0),
    byte_size integer NOT NULL CHECK (byte_size >= 0),
    content_sha256 text NOT NULL
        CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    content bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (skill_version_id, relative_path),
    CHECK (octet_length(content) = byte_size),
    CHECK (
        relative_path = btrim(relative_path)
        AND relative_path !~ '^/'
        AND relative_path !~ '/$'
        AND relative_path !~ '//'
        AND relative_path !~ '(^|/)\.\.?($|/)'
        AND position(E'\\' in relative_path) = 0
        AND (
            relative_path LIKE 'references/%'
            OR relative_path LIKE 'assets/%'
        )
    )
);

CREATE INDEX IF NOT EXISTS reply_skill_resource_version_idx
    ON public.reply_skill_resource (skill_version_id, resource_kind, relative_path);

COMMENT ON COLUMN public.reply_skill_resource.id IS
    '受控 Skill 辅助资源的内部 UUID。';
COMMENT ON TABLE public.reply_skill_resource IS
    'Reply Skill 不可变版本的受控 references/assets 内容；不提供任意文件读取。';
COMMENT ON COLUMN public.reply_skill_resource.skill_version_id IS
    '资源所属的不可变 reply_skill_version；版本删除时级联删除。';
COMMENT ON COLUMN public.reply_skill_resource.relative_path IS
    '包内相对路径，只允许 references/ 或 assets/ 前缀。';
COMMENT ON COLUMN public.reply_skill_resource.resource_kind IS
    '资源类型：reference 为长说明或案例，asset 为受控静态模板或素材。';
COMMENT ON COLUMN public.reply_skill_resource.media_type IS
    '经导入校验确定的静态媒体类型。';
COMMENT ON COLUMN public.reply_skill_resource.byte_size IS
    '资源内容的字节数；必须与 content 的实际长度一致。';
COMMENT ON COLUMN public.reply_skill_resource.content_sha256 IS
    '资源内容 SHA-256；由 Skill 管理适配器在发布前计算。';
COMMENT ON COLUMN public.reply_skill_resource.content IS
    '经完整校验后保存的静态资源内容；运行时只能按版本和相对路径读取。';
COMMENT ON COLUMN public.reply_skill_resource.created_at IS
    '资源记录写入时间。';
COMMENT ON COLUMN public.reply_skill_version.validation_warnings IS
    'Skill 包质量校验警告数组；结构或安全校验失败不会进入版本表。';

COMMIT;
