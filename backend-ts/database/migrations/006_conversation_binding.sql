BEGIN;

CREATE TABLE public.conversation_binding (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    channel text NOT NULL CHECK (channel IN ('wechat')),
    account_scope text NOT NULL CHECK (length(btrim(account_scope)) > 0),
    conversation_locator text NOT NULL
        CHECK (length(btrim(conversation_locator)) > 0),
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked')),
    last_verified_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE,
    CHECK (
        (status = 'active' AND revoked_at IS NULL)
        OR (status = 'revoked' AND revoked_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX conversation_binding_active_locator_unique
    ON public.conversation_binding (
        owner_id,
        channel,
        account_scope,
        conversation_locator
    )
    WHERE status = 'active';

CREATE INDEX conversation_binding_contact_idx
    ON public.conversation_binding (owner_id, contact_id, status, updated_at DESC);

COMMENT ON TABLE public.conversation_binding IS
    '用户确认的桌面聊天会话到 NotAlone 联系人的绑定，不保存聊天正文。';
COMMENT ON COLUMN public.conversation_binding.id IS
    'NotAlone 内部生成的稳定会话绑定 UUID。';
COMMENT ON COLUMN public.conversation_binding.owner_id IS
    '绑定所属的 NotAlone 用户 UUID。';
COMMENT ON COLUMN public.conversation_binding.contact_id IS
    '绑定所属的 NotAlone 联系人 UUID。';
COMMENT ON COLUMN public.conversation_binding.channel IS
    '聊天渠道；v1 仅支持 wechat。';
COMMENT ON COLUMN public.conversation_binding.account_scope IS
    '聊天渠道账号范围，由适配器提供的非昵称标识。';
COMMENT ON COLUMN public.conversation_binding.conversation_locator IS
    '定位已确认会话的适配器标识，不是联系人昵称或聊天正文。';
COMMENT ON COLUMN public.conversation_binding.status IS
    '绑定状态：active 或 revoked。';
COMMENT ON COLUMN public.conversation_binding.last_verified_at IS
    '最近一次通过当前会话验证的时间。';
COMMENT ON COLUMN public.conversation_binding.created_at IS
    '绑定创建时间。';
COMMENT ON COLUMN public.conversation_binding.updated_at IS
    '绑定状态或验证时间最后更新的时间。';
COMMENT ON COLUMN public.conversation_binding.revoked_at IS
    '绑定撤销时间；active 绑定为空。';

COMMIT;
