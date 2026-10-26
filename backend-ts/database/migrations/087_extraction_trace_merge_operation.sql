BEGIN;

-- 合并采纳已有来源与删除链路，追踪回执也须允许记录这一实际操作。
ALTER TABLE public.memory_extraction_trace_link
    DROP CONSTRAINT memory_extraction_trace_link_operation_check;
ALTER TABLE public.memory_extraction_trace_link
    ADD CONSTRAINT memory_extraction_trace_link_operation_check
    CHECK (operation IN ('input', 'save', 'invalidate', 'merge'));
COMMENT ON COLUMN public.memory_extraction_trace_link.operation IS 'input 表示窗口消息；merge 表示合并写入；invalidate 回执须核对权威记忆失效状态。';

COMMIT;
