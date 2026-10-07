BEGIN;

-- 消息参与批次与业务写入分别关联；正文删除后保留无正文定位。
ALTER TABLE public.memory_extraction_trace_link
    DROP CONSTRAINT memory_extraction_trace_link_record_kind_check;
ALTER TABLE public.memory_extraction_trace_link
    ADD CONSTRAINT memory_extraction_trace_link_record_kind_check
    CHECK (record_kind IN ('message', 'candidate', 'contact_memory', 'owner_memory'));
ALTER TABLE public.memory_extraction_trace_link
    ADD COLUMN operation text NOT NULL DEFAULT 'save'
    CHECK (operation IN ('input', 'save', 'invalidate'));
COMMENT ON COLUMN public.memory_extraction_trace_link.operation IS 'input 表示实际窗口消息；invalidate 回执须核对权威记忆失效状态。';

COMMIT;
