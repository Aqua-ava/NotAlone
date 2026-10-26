BEGIN;

-- 引入 message_source_ref 来源引用表：message 去掉对 source_document 的硬依赖，
-- 一条规范消息可由历史导入和本地微信 CLI 观察共同支持；
-- 删除一个来源只移除该来源引用，所有来源引用都删除后才清理消息和派生资料。
-- 跨来源去重的稳定消息身份沿用迁移 014 的微信唯一键
-- (owner_id, contact_id, external_local_id, source_create_time)，
-- 缺失 create_time 的 CLI 消息按 (external_local_id, 未知时间) 参与去重。

-- 1) 先移除依赖旧复合唯一键与 source_document 列的外键。
ALTER TABLE public.message
    DROP CONSTRAINT message_owner_id_contact_id_source_document_id_fkey;

ALTER TABLE public.wechat_message_metadata
    DROP CONSTRAINT wechat_message_metadata_owner_id_contact_id_source_documen_fkey;

-- 2) message 的范围唯一键改为 (id, owner_id, contact_id)，供来源引用表做范围外键。
ALTER TABLE public.message
    DROP CONSTRAINT message_scope_identity_unique,
    ADD CONSTRAINT message_scope_identity_unique
        UNIQUE (id, owner_id, contact_id);

-- 3) 来源引用表：一条规范消息与一个来源（导入或 CLI 观察）的关联证据。
CREATE TABLE public.message_source_ref (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    source_kind text NOT NULL
        CHECK (source_kind IN ('source_document', 'local_wechat_observation')),
    source_document_id uuid,
    observation_id uuid,
    source_locator text NOT NULL
        CHECK (length(btrim(source_locator)) > 0),
    raw_payload jsonb NOT NULL CHECK (jsonb_typeof(raw_payload) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (message_id, owner_id, contact_id)
        REFERENCES public.message(id, owner_id, contact_id) ON DELETE CASCADE,
    FOREIGN KEY (source_document_id)
        REFERENCES public.source_document(id) ON DELETE CASCADE,
    FOREIGN KEY (observation_id)
        REFERENCES public.local_wechat_observation(id) ON DELETE CASCADE,
    CONSTRAINT message_source_ref_single_source_check
        CHECK (
            (source_kind = 'source_document'
                AND source_document_id IS NOT NULL
                AND observation_id IS NULL)
            OR (source_kind = 'local_wechat_observation'
                AND observation_id IS NOT NULL
                AND source_document_id IS NULL)
        ),
    CONSTRAINT message_source_ref_document_locator_unique
        UNIQUE (source_document_id, source_locator),
    CONSTRAINT message_source_ref_observation_locator_unique
        UNIQUE (observation_id, source_locator)
);

CREATE INDEX message_source_ref_message_idx
    ON public.message_source_ref (message_id);

-- 4) 把既有消息迁移为指向其导入来源的引用；raw_payload 随引用保存。
INSERT INTO public.message_source_ref (
    message_id,
    owner_id,
    contact_id,
    source_kind,
    source_document_id,
    source_locator,
    raw_payload
)
SELECT
    message.id,
    message.owner_id,
    message.contact_id,
    'source_document',
    message.source_document_id,
    message.source_locator,
    metadata.raw_payload
FROM public.message AS message
JOIN public.wechat_message_metadata AS metadata
  ON metadata.message_id = message.id
ON CONFLICT (source_document_id, source_locator) DO NOTHING;

DO $$
BEGIN
    IF (SELECT count(*) FROM public.message)
       <> (SELECT count(*) FROM public.message_source_ref) THEN
        RAISE EXCEPTION 'message_source_ref 回填行数与 message 不一致';
    END IF;
END $$;

-- 5) wechat_message_metadata 收敛为纯微信消息身份：去掉来源列与原始 JSON，
--    身份键允许 CLI 消息缺失 server_id 或 create_time。
ALTER TABLE public.wechat_message_metadata
    DROP CONSTRAINT wechat_message_metadata_source_local_time_unique,
    DROP CONSTRAINT wechat_message_metadata_contact_local_time_unique,
    DROP COLUMN source_document_id,
    DROP COLUMN raw_payload,
    ALTER COLUMN source_create_time DROP NOT NULL,
    ALTER COLUMN external_server_id DROP NOT NULL,
    ADD CONSTRAINT wechat_message_metadata_message_fkey
        FOREIGN KEY (message_id) REFERENCES public.message(id) ON DELETE CASCADE;

-- 稳定消息身份：同一 owner/contact 下的 (local_id, create_time) 只归属一条规范消息；
-- create_time 缺失时以 -1 参与同一唯一键，保证重复事件仍可去重。
CREATE UNIQUE INDEX wechat_message_metadata_stable_identity_unique
    ON public.wechat_message_metadata (
        owner_id,
        contact_id,
        external_local_id,
        COALESCE(source_create_time, -1)
    );

-- 6) message 去掉来源硬依赖列；message_source_idx 随列自动删除。
ALTER TABLE public.message
    DROP CONSTRAINT message_source_locator_unique,
    DROP CONSTRAINT message_source_locator_non_empty,
    DROP COLUMN source_document_id,
    DROP COLUMN source_locator;

COMMENT ON TABLE public.message_source_ref IS
    '一条规范消息与一个来源（导入来源或本地微信 CLI 观察）的引用证据；删除来源只移除其引用。';
COMMENT ON COLUMN public.message_source_ref.source_kind IS
    '来源类型：source_document 为历史导入来源，local_wechat_observation 为 CLI 增量观察。';
COMMENT ON COLUMN public.message_source_ref.source_document_id IS
    '引用的导入来源 UUID；仅 source_document 引用填写。';
COMMENT ON COLUMN public.message_source_ref.observation_id IS
    '引用的本地微信 CLI 观察来源 UUID；仅 local_wechat_observation 引用填写。';
COMMENT ON COLUMN public.message_source_ref.source_locator IS
    '消息在所属来源内的稳定定位符，由输入适配器生成。';
COMMENT ON COLUMN public.message_source_ref.raw_payload IS
    '该来源提供的原始证据对象，只用于来源复核和删除，不进入回复检索。';

COMMENT ON TABLE public.wechat_message_metadata IS
    '微信消息的稳定身份证据；一条规范消息一行，导入与 CLI 观察共用同一身份键去重。';
COMMENT ON COLUMN public.wechat_message_metadata.external_server_id IS
    '原始 server_id_str；CLI 事件缺失时为空。';
COMMENT ON COLUMN public.wechat_message_metadata.source_create_time IS
    '原始 create_time 数值，与 external_local_id 共同构成稳定消息身份；缺失时为空。';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.message AS message
        WHERE NOT EXISTS (
            SELECT 1
            FROM public.message_source_ref AS ref
            WHERE ref.message_id = message.id
        )
    ) THEN
        RAISE EXCEPTION '迁移后仍存在没有来源引用的规范消息';
    END IF;
END $$;

COMMIT;
