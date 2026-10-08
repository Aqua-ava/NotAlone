BEGIN;

-- 全局 CLI 后台读取使用的来源模式，与前台现场和切回补读区分。
ALTER TABLE public.local_wechat_observation
    DROP CONSTRAINT IF EXISTS local_wechat_observation_mode_check;
ALTER TABLE public.local_wechat_observation
    ADD CONSTRAINT local_wechat_observation_mode_check
    CHECK (mode IN ('live', 'cli_catchup', 'cli_background'));

COMMENT ON COLUMN public.local_wechat_observation.mode IS
    '观察模式：live 为前台实时读取，cli_catchup 为切回联系人后的补读，cli_background 为全局 CLI 后台读取。';

-- 新绑定的后台 CLI 首次读取只从用户确认时建立的时间基线开始，
-- 避免把既有历史默默补入增量同步。每个绑定保留自己的 baseline。
CREATE TABLE IF NOT EXISTS public.wechat_observation_baseline (
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    binding_id uuid NOT NULL,
    conversation_locator text NOT NULL
        CHECK (length(btrim(conversation_locator)) > 0),
    baseline_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, contact_id, binding_id),
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE,
    FOREIGN KEY (binding_id)
        REFERENCES public.conversation_binding(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS wechat_observation_baseline_scope_idx
    ON public.wechat_observation_baseline (owner_id, contact_id);

COMMENT ON TABLE public.wechat_observation_baseline IS
    '已确认会话绑定首次启用 CLI 增量读取的时间基线；不保存消息正文。';
COMMENT ON COLUMN public.wechat_observation_baseline.conversation_locator IS
    '建立 baseline 时绑定的外部稳定会话定位标识。';
COMMENT ON COLUMN public.wechat_observation_baseline.baseline_at IS
    '用户确认绑定时记录的起始时间；首次读取只请求该时间之后的消息。';

COMMIT;
