BEGIN;

ALTER TABLE public.assistant_session_turn
    DROP CONSTRAINT assistant_session_turn_interruption_reason_check;
ALTER TABLE public.assistant_session_turn
    ADD CONSTRAINT assistant_session_turn_interruption_reason_check
    CHECK (interruption_reason IS NULL OR
           (interruption_reason IN ('app_quit', 'configuration_reload', 'user_cancelled')
            AND state IN ('failed', 'redacted')));

COMMENT ON COLUMN public.assistant_session_turn.interruption_reason IS
    '生成中断原因；区分应用退出、设置重载与用户主动停止，空值表示没有中断。';

COMMIT;
