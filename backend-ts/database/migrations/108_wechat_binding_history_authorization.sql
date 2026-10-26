BEGIN;

-- 账号级旧决定保留；新绑定的历史读取只能使用当次明确确认的绑定快照。
CREATE TABLE public.wechat_binding_history_authorization (
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    binding_id uuid NOT NULL,
    version integer NOT NULL CHECK (version = 1),
    authorized_at timestamptz NOT NULL,
    PRIMARY KEY (owner_id, contact_id, binding_id),
    FOREIGN KEY (owner_id, contact_id, binding_id)
        REFERENCES public.conversation_binding(owner_id, contact_id, id) ON DELETE CASCADE
);

-- 仅升级时保留已经明确同意且仍有效的当前绑定；未来新增没有此快照。
INSERT INTO public.wechat_binding_history_authorization
    (owner_id,contact_id,binding_id,version,authorized_at)
SELECT b.owner_id,b.contact_id,b.id,1,a.decided_at
FROM public.conversation_binding b
JOIN public.wechat_history_sync_authorization a
  ON a.owner_id=b.owner_id AND a.channel=b.channel AND a.account_scope=b.account_scope
JOIN public.owner_channel_identity i
  ON i.owner_id=b.owner_id AND i.channel=b.channel AND i.external_id=b.account_scope AND i.status='active'
WHERE b.status='active' AND a.version=1 AND a.decision='accepted'
  AND NOT EXISTS (SELECT 1 FROM public.wechat_sync_exclusion e
    WHERE e.owner_id=b.owner_id AND e.channel=b.channel AND e.account_scope=b.account_scope
      AND e.locator_hash=sha256(convert_to(b.conversation_locator,'UTF8')));

COMMENT ON TABLE public.wechat_binding_history_authorization IS
    '明确历史同意所覆盖的绑定快照；不向新增、撤销或重新绑定会话自动传播，账号旧决定保持原样。';
COMMIT;
