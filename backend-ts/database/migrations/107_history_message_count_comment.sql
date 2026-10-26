BEGIN;

-- 已执行的 104 保留原始字节；计数语义的注释修订通过新版本前向应用。
COMMENT ON COLUMN public.cli_history_sync_state.message_count IS
    '本绑定历史同步累计处理的规范文字消息数量；重叠历史复用既有消息时同样计数。';

COMMIT;
