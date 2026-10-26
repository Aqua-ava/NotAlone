BEGIN;

ALTER TABLE public.assistant_session_turn
    ADD COLUMN interruption_reason text,
    ADD CONSTRAINT assistant_session_turn_interruption_reason_check
    CHECK (
        interruption_reason IS NULL
        OR (interruption_reason = 'app_quit' AND state IN ('failed', 'redacted'))
    );

COMMENT ON COLUMN public.assistant_session_turn.interruption_reason IS
    '仅记录无正文退出分类；旧请求键持续失效，生成只能由用户显式新请求重试。';

COMMIT;
