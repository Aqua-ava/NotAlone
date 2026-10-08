BEGIN;

-- 把“CLI 返回了水位”与“来源、规范消息和水位同一事务成功提交”区分开。
-- 既有观察默认不可靠，恢复时宁可从 baseline 或更早可靠批次重放，不能
-- 用历史上曾经前移的游标掩盖消息缺口。
ALTER TABLE public.local_wechat_observation
    ADD COLUMN IF NOT EXISTS event_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS non_text_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS is_reliable boolean NOT NULL DEFAULT false;

UPDATE public.local_wechat_observation
SET event_count = GREATEST(event_count, record_count)
WHERE event_count < record_count;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.local_wechat_observation'::regclass
          AND conname = 'local_wechat_observation_event_count_check'
    ) THEN
        ALTER TABLE public.local_wechat_observation
            ADD CONSTRAINT local_wechat_observation_event_count_check
            CHECK (event_count >= record_count);
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.local_wechat_observation'::regclass
          AND conname = 'local_wechat_observation_non_text_count_check'
    ) THEN
        ALTER TABLE public.local_wechat_observation
            ADD CONSTRAINT local_wechat_observation_non_text_count_check
            CHECK (non_text_count >= 0 AND non_text_count <= event_count);
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS local_wechat_observation_reliable_idx
    ON public.local_wechat_observation (
        owner_id, contact_id, binding_id, last_local_id DESC, read_at DESC
    )
    WHERE is_reliable;

COMMENT ON COLUMN public.local_wechat_observation.event_count IS
    '本次读取返回的事件总数，包含非文字事件；只保存计数。';
COMMENT ON COLUMN public.local_wechat_observation.non_text_count IS
    '本次读取返回的非文字事件数量；不把媒体事件伪造成文字。';
COMMENT ON COLUMN public.local_wechat_observation.is_reliable IS
    '来源、规范消息和联系人游标是否在同一成功边界内提交；历史记录默认 false。';

ALTER TABLE public.cli_backfill_state
    ADD COLUMN IF NOT EXISTS non_text_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.cli_backfill_state
    DROP CONSTRAINT IF EXISTS cli_backfill_state_non_text_count_check,
    ADD CONSTRAINT cli_backfill_state_non_text_count_check
        CHECK (non_text_count >= 0);

COMMENT ON COLUMN public.cli_backfill_state.non_text_count IS
    '补齐范围内已读取但未规范化为文字的事件数量；只保存计数。';

COMMIT;
