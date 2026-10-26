BEGIN;

CREATE TABLE public.skill_library (
    owner_id uuid PRIMARY KEY REFERENCES public.owner(id) ON DELETE CASCADE,
    revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.reply_skill (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    contact_id uuid,
    name text NOT NULL
        CHECK (
            length(btrim(name)) BETWEEN 1 AND 64
            AND name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
        ),
    description text NOT NULL CHECK (length(btrim(description)) > 0),
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled', 'deleted')),
    deleted_at timestamptz,
    deletion_operation_id uuid,
    deletion_error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE,
    UNIQUE (owner_id, name),
    CHECK (
        (status IN ('active', 'disabled') AND deleted_at IS NULL)
        OR (status = 'deleted' AND deleted_at IS NOT NULL)
    )
);

CREATE TABLE public.reply_skill_version (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_id uuid NOT NULL
        REFERENCES public.reply_skill(id) ON DELETE CASCADE,
    version_number integer NOT NULL CHECK (version_number > 0),
    name text NOT NULL
        CHECK (
            length(btrim(name)) BETWEEN 1 AND 64
            AND name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
        ),
    description text NOT NULL CHECK (length(btrim(description)) > 0),
    content text,
    content_sha256 text
        CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
    source_locator text,
    enabled boolean NOT NULL DEFAULT true,
    is_current boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'deleted')),
    deleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (skill_id, version_number),
    CHECK (
        (
            status = 'active'
            AND deleted_at IS NULL
            AND content IS NOT NULL
            AND length(btrim(content)) > 0
        )
        OR (
            status = 'deleted'
            AND deleted_at IS NOT NULL
            AND content IS NULL
            AND source_locator IS NULL
            AND enabled = false
        )
    )
);

CREATE UNIQUE INDEX reply_skill_current_version_unique
    ON public.reply_skill_version (skill_id)
    WHERE is_current;

CREATE INDEX reply_skill_scope_status_idx
    ON public.reply_skill (owner_id, contact_id, status, name);

CREATE INDEX reply_skill_version_read_idx
    ON public.reply_skill_version (skill_id, status, enabled, is_current);

COMMENT ON TABLE public.skill_library IS
    'owner 级 Reply Skill 目录修订；Skill 管理事务负责递增 revision。';
COMMENT ON COLUMN public.skill_library.revision IS
    '同一 owner 任一 Skill 生命周期变化后的单调递增修订号。';
COMMENT ON TABLE public.reply_skill IS
    'Reply Skill 目录项；只读 SkillPort 不负责创建、更新或删除。';
COMMENT ON COLUMN public.reply_skill.contact_id IS
    '为空表示 owner 全局 Skill，否则只适用于该 owner 下的指定联系人。';
COMMENT ON COLUMN public.reply_skill.name IS
    '同一 owner 内唯一的稳定 Skill 名称。';
COMMENT ON COLUMN public.reply_skill.status IS
    'Skill 状态：active、disabled 或 deleted；删除后保留最小审计记录。';
COMMENT ON TABLE public.reply_skill_version IS
    '发布后的 Reply Skill 不可变版本；SkillPort 只读取当前启用版本。';
COMMENT ON COLUMN public.reply_skill_version.content IS
    '经校验的 SKILL.md 正文；删除状态必须清空。';
COMMENT ON COLUMN public.reply_skill_version.source_locator IS
    'Skill 来源定位；删除状态必须清空。';
COMMENT ON COLUMN public.reply_skill_version.is_current IS
    '该 Skill 当前发布版本标记；同一 Skill 最多一个当前版本。';

COMMIT;
