BEGIN;

-- 与消息流的 NULL 时间及同时间 UUID 倒序保持一致；旧时间索引继续服务 ASC 检索。
CREATE INDEX message_contact_page_idx
    ON public.message (owner_id, contact_id, occurred_at DESC NULLS LAST, id DESC);

-- 引用目标按同一 owner/contact 与服务端标识定位；重号仍可返回多个目标。
CREATE INDEX wechat_message_metadata_scope_server_idx
    ON public.wechat_message_metadata (owner_id, contact_id, external_server_id);

COMMIT;
