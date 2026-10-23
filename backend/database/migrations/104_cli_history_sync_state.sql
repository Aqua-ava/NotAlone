BEGIN;

-- 首绑完整历史同步的覆盖状态。每个 owner + contact + binding 独立保存
-- 阶段、检查点、计数和失败原因；只保存元数据，不保存聊天正文。
-- 行不存在表示“尚未开始”；检查点只能由同一来源批次事务推进。
CREATE TABLE IF NOT EXISTS public.cli_history_sync_state (
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    binding_id uuid NOT NULL,
    phase text NOT NULL
        CHECK (phase IN ('syncing', 'complete', 'incomplete')),
    watermark_at timestamptz NOT NULL,
    message_count integer NOT NULL DEFAULT 0
        CHECK (message_count >= 0),
    non_text_count integer NOT NULL DEFAULT 0
        CHECK (non_text_count >= 0),
    page_count integer NOT NULL DEFAULT 0
        CHECK (page_count >= 0),
    last_local_id bigint,
    last_cursor text,
    failure_code text,
    started_at timestamptz NOT NULL,
    completed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, contact_id, binding_id),
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE,
    CONSTRAINT cli_history_sync_state_binding_scope_fkey
        FOREIGN KEY (owner_id, contact_id, binding_id)
        REFERENCES public.conversation_binding(owner_id, contact_id, id)
        ON DELETE CASCADE,
    CHECK (
        (last_local_id IS NULL AND last_cursor IS NULL)
        OR (last_local_id > 0 AND last_cursor IS NOT NULL
            AND length(btrim(last_cursor)) > 0)
    )
);

CREATE INDEX IF NOT EXISTS cli_history_sync_state_phase_idx
    ON public.cli_history_sync_state (owner_id, phase, updated_at DESC);

COMMENT ON TABLE public.cli_history_sync_state IS
    '首绑完整历史同步覆盖状态；只保存检查点、计数和原因等元数据，不保存聊天正文。';
COMMENT ON COLUMN public.cli_history_sync_state.watermark_at IS
    '首次开始历史同步时固定的活动水位；历史追到该水位后才可能标记完整。';
COMMENT ON COLUMN public.cli_history_sync_state.message_count IS
    '本绑定历史同步累计处理的规范文字消息数量；重叠历史复用既有消息时同样计数。';
COMMENT ON COLUMN public.cli_history_sync_state.last_cursor IS
    '本绑定最近一个成功提交历史页的 CLI 游标；只有来源与消息提交成功后才更新。';
COMMENT ON COLUMN public.cli_history_sync_state.failure_code IS
    '不含聊天正文的稳定不完整原因；空结果、本机删除、缺表或异常输出不得标记完整。';

-- 历史页使用独立来源模式，和实时增量、补齐观察来源区分。
ALTER TABLE public.local_wechat_observation
    DROP CONSTRAINT IF EXISTS local_wechat_observation_mode_check;
ALTER TABLE public.local_wechat_observation
    ADD CONSTRAINT local_wechat_observation_mode_check
    CHECK (mode IN ('live', 'cli_catchup', 'cli_background', 'cli_history'));

COMMENT ON COLUMN public.local_wechat_observation.mode IS
    '观察模式：live 为前台实时读取，cli_catchup 为切回联系人后的补读，cli_background 为全局 CLI 后台读取，cli_history 为首绑完整历史分页。';

COMMIT;
