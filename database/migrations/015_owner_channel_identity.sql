BEGIN;

CREATE TABLE public.owner_channel_identity (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    channel text NOT NULL CHECK (channel IN ('wechat')),
    external_id text NOT NULL CHECK (length(btrim(external_id)) > 0),
    observed_name text NOT NULL CHECK (length(btrim(observed_name)) > 0),
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked')),
    verified_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX owner_channel_identity_active_external_unique
    ON public.owner_channel_identity (channel, external_id)
    WHERE status = 'active';

CREATE UNIQUE INDEX owner_channel_identity_active_owner_channel_unique
    ON public.owner_channel_identity (owner_id, channel)
    WHERE status = 'active';

COMMENT ON TABLE public.owner_channel_identity IS
    'NotAlone owner 在外部聊天渠道中的已验证身份，不等同于 owner_id。';
COMMENT ON COLUMN public.owner_channel_identity.external_id IS
    '外部渠道身份，例如微信 sender_wxid；不作为 NotAlone owner_id。';
COMMENT ON COLUMN public.owner_channel_identity.observed_name IS
    '导入或绑定时观察到的渠道展示名称，不覆盖 owner.display_name。';

COMMIT;
