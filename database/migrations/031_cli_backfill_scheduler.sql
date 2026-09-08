BEGIN;

-- 补齐状态的暂停是用户可见的生命周期，不等同于失败或完成。
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.cli_backfill_state'::regclass
          AND conname = 'cli_backfill_state_phase_check'
          AND pg_get_constraintdef(oid) LIKE '%paused%'
    ) THEN
        ALTER TABLE public.cli_backfill_state
            DROP CONSTRAINT IF EXISTS cli_backfill_state_phase_check;
        ALTER TABLE public.cli_backfill_state
            ADD CONSTRAINT cli_backfill_state_phase_check
            CHECK (phase IN (
                'gap_detected', 'backfilling', 'complete', 'failed',
                'incomplete', 'paused'
            ));
    END IF;
END
$$;

COMMENT ON COLUMN public.cli_backfill_state.phase IS
    '补齐生命周期：发现缺口、补齐中、暂停、完成、失败或无法确认完整。';

COMMIT;
