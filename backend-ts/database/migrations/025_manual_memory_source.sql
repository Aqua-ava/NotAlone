-- 025：手动录入记忆的来源类型。
--
-- 手动录入的联系人级记忆同样需要一条来源记录才能通过
-- "仍有有效来源" 的检索过滤；这里把 source_type 约束放宽，
-- 允许 'manual' 类型标记用户手动录入的来源。
--
-- 删除凭证约束（非 deleted 时必须带 file_name/content_sha256/record_count）
-- 对手动来源同样成立：手动录入会创建一条完整的来源记录。

ALTER TABLE public.source_document
    DROP CONSTRAINT source_document_source_type_check;

ALTER TABLE public.source_document
    ADD CONSTRAINT source_document_source_type_check
    CHECK (source_type IN ('wechat_jsonl', 'manual'));