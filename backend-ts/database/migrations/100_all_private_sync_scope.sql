BEGIN;

-- 不迁移旧开关为全部授权；缺省由读取端解释为 selected。
CREATE TABLE public.wechat_sync_scope (
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    channel text NOT NULL CHECK (channel = 'wechat'),
    account_scope text NOT NULL CHECK (length(btrim(account_scope)) > 0),
    mode text NOT NULL CHECK (mode IN ('selected', 'all_private')),
    granted_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, channel, account_scope),
    CHECK (mode <> 'all_private' OR granted_at IS NOT NULL)
);

-- 只保留会话标识摘要，联系人级联删除后仍能阻止自动重新建立。
CREATE TABLE public.wechat_sync_exclusion (
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    channel text NOT NULL,
    account_scope text NOT NULL,
    locator_hash bytea NOT NULL,
    excluded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, channel, account_scope, locator_hash)
);
INSERT INTO public.wechat_sync_exclusion(owner_id,channel,account_scope,locator_hash)
SELECT owner_id,channel,account_scope,sha256(convert_to(conversation_locator,'UTF8'))
FROM public.conversation_binding WHERE status='revoked'
ON CONFLICT DO NOTHING;

CREATE FUNCTION public.exclude_removed_wechat_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR NEW.status = 'revoked' THEN
        -- 删除 owner 时不再创建其排除记录。
        IF EXISTS (SELECT 1 FROM public.owner WHERE id=OLD.owner_id) THEN
            INSERT INTO public.wechat_sync_exclusion(owner_id,channel,account_scope,locator_hash)
            VALUES(OLD.owner_id,OLD.channel,OLD.account_scope,sha256(convert_to(OLD.conversation_locator,'UTF8')))
            ON CONFLICT DO NOTHING;
        END IF;
    END IF;
    RETURN OLD;
END;
$$;
CREATE TRIGGER wechat_binding_exclusion
AFTER DELETE OR UPDATE OF status ON public.conversation_binding
FOR EACH ROW EXECUTE FUNCTION public.exclude_removed_wechat_binding();

COMMENT ON TABLE public.wechat_sync_scope IS '用户明确授予当前微信账号的持续私聊同步范围；不改变同步总开关。';
COMMENT ON TABLE public.wechat_sync_exclusion IS '撤销或删除过的会话摘要；全部私聊授权不能覆盖单独撤销。';
COMMIT;
