BEGIN;

-- 运行记录扩展：记录一次候选回复实际使用的 Skill 版本之外的
-- 选择方式、选择原因、加载状态和已加载的资源路径摘要。
-- 这些是非正文审计数据；不保存 Skill 正文、完整 Prompt 或聊天原文。
ALTER TABLE public.reply_request
    ADD COLUMN IF NOT EXISTS skill_selection_method text,
    ADD COLUMN IF NOT EXISTS skill_selection_reason text,
    ADD COLUMN IF NOT EXISTS skill_load_state text,
    ADD COLUMN IF NOT EXISTS skill_loaded_resources jsonb;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'reply_request_skill_meta_check'
          AND conrelid = 'public.reply_request'::regclass
    ) THEN
        ALTER TABLE public.reply_request
            ADD CONSTRAINT reply_request_skill_meta_check CHECK (
                -- 没有 Skill 时不允许填写选择或加载元数据。
                NOT (
                    skill_id IS NULL
                    AND (
                        skill_selection_method IS NOT NULL
                        OR skill_selection_reason IS NOT NULL
                        OR skill_load_state IS NOT NULL
                        OR skill_loaded_resources IS NOT NULL
                    )
                )
                -- 填写了字段时必须使用受控取值。
                AND (
                    skill_selection_method IS NULL
                    OR skill_selection_method IN ('auto', 'user')
                )
                AND (
                    skill_load_state IS NULL
                    OR skill_load_state IN ('loaded', 'resource_failed')
                )
                AND (
                    skill_loaded_resources IS NULL
                    OR jsonb_typeof(skill_loaded_resources) = 'array'
                )
                AND (
                    skill_selection_reason IS NULL
                    OR length(btrim(skill_selection_reason)) > 0
                )
                AND (
                    skill_selection_reason IS NULL
                    OR skill_selection_method IS NOT NULL
                )
            );
    END IF;
END
$$;

COMMENT ON COLUMN public.reply_request.skill_selection_method IS
    'Skill 选择方式：auto 为系统按目录推荐，user 为用户显式选择。';
COMMENT ON COLUMN public.reply_request.skill_selection_reason IS
    '紧随 Skill 选择方式的非正文选择原因摘要。';
COMMENT ON COLUMN public.reply_request.skill_load_state IS
    'Skill 加载状态：loaded 为正文与资源加载成功，resource_failed 为资源读取失败。';
COMMENT ON COLUMN public.reply_request.skill_loaded_resources IS
    '本次实际读取的辅助资源相对路径数组；不保存资源正文。';

COMMIT;
