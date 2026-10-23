BEGIN;
-- 与迁移021的稳定身份一致；不回填已经丢失身份的历史删除。
CREATE TABLE public.wechat_auto_read_suppression (
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    external_local_id bigint NOT NULL,
    identity_create_time bigint NOT NULL,
    deleted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, contact_id, external_local_id, identity_create_time),
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE
);
COMMENT ON TABLE public.wechat_auto_read_suppression IS
    '无正文稳定身份抑制；自动新捕获、重启及一般重绑不得恢复已删内容；显式重新预览确认仅创建独立新来源。';
COMMENT ON TABLE public.source_processing_capture_tombstone IS
    '无正文捕获UUID墓碑；新捕获仍须通过稳定身份自动读取抑制，普通重启或重绑不构成恢复已删内容的授权。';
COMMIT;
