BEGIN;

-- CLI 后台补齐只保存范围、时间、状态、计数、游标和失败原因等审计元数据，
-- 不保存聊天正文；联系人或绑定删除时按既有范围级联清理。
-- 为状态表的复合外键提供“binding 属于同一 owner/contact”的唯一键。
CREATE UNIQUE INDEX IF NOT EXISTS conversation_binding_owner_contact_id_unique
    ON public.conversation_binding (owner_id, contact_id, id);

CREATE TABLE IF NOT EXISTS public.cli_backfill_state (
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    binding_id uuid NOT NULL,
    phase text NOT NULL
        CHECK (phase IN (
            'gap_detected', 'backfilling', 'complete', 'failed', 'incomplete'
        )),
    trigger_at timestamptz NOT NULL,
    message_count integer NOT NULL DEFAULT 0
        CHECK (message_count >= 0),
    last_local_id bigint,
    last_cursor text,
    failure_code text,
    started_at timestamptz,
    completed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, contact_id, binding_id),
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE,
    CONSTRAINT cli_backfill_state_binding_scope_fkey
        FOREIGN KEY (owner_id, contact_id, binding_id)
        REFERENCES public.conversation_binding(owner_id, contact_id, id)
        ON DELETE CASCADE,
    CHECK (
        (last_local_id IS NULL AND last_cursor IS NULL)
        OR (last_local_id > 0 AND last_cursor IS NOT NULL
            AND length(btrim(last_cursor)) > 0)
    )
);

-- 若早期开发库已经手工创建过同名表，补上复合外键而不要求删除数据。
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'cli_backfill_state_binding_scope_fkey'
          AND conrelid = 'public.cli_backfill_state'::regclass
    ) THEN
        ALTER TABLE public.cli_backfill_state
            ADD CONSTRAINT cli_backfill_state_binding_scope_fkey
            FOREIGN KEY (owner_id, contact_id, binding_id)
            REFERENCES public.conversation_binding(owner_id, contact_id, id)
            ON DELETE CASCADE;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS cli_backfill_state_phase_idx
    ON public.cli_backfill_state (owner_id, phase, updated_at DESC);

COMMENT ON TABLE public.cli_backfill_state IS
    'CLI 后台同步缺口补齐状态；只保存审计元数据，不保存聊天正文。';
COMMENT ON COLUMN public.cli_backfill_state.trigger_at IS
    '触发本次缺口检测的同步重新开启时间；同一触发只处理一次。';
COMMENT ON COLUMN public.cli_backfill_state.message_count IS
    '本次补齐成功写入的规范文字消息数量。';
COMMENT ON COLUMN public.cli_backfill_state.last_cursor IS
    '本次补齐成功批次的 CLI 游标；只有来源与消息提交成功后才更新。';
COMMENT ON COLUMN public.cli_backfill_state.failure_code IS
    '不含聊天正文的稳定失败分类。';

COMMIT;
