BEGIN;

ALTER TABLE public.message
    ADD COLUMN source_locator text,
    ADD COLUMN media_placeholder text;

UPDATE public.message
SET source_locator = 'wechat-local:' || external_local_id::text;

ALTER TABLE public.message
    ALTER COLUMN source_locator SET NOT NULL,
    ADD CONSTRAINT message_source_locator_non_empty
        CHECK (length(btrim(source_locator)) > 0),
    ADD CONSTRAINT message_content_present
        CHECK (
            length(btrim(text_content)) > 0
            OR (
                media_placeholder IS NOT NULL
                AND length(btrim(media_placeholder)) > 0
            )
        ),
    ADD CONSTRAINT message_source_locator_unique
        UNIQUE (source_document_id, source_locator),
    ADD CONSTRAINT message_scope_identity_unique
        UNIQUE (owner_id, contact_id, source_document_id, id);

ALTER TABLE public.message
    DROP CONSTRAINT message_contact_external_local_id_unique,
    DROP CONSTRAINT message_source_document_id_external_local_id_key;

CREATE TABLE public.wechat_message_metadata (
    message_id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    source_document_id uuid NOT NULL,
    external_local_id bigint NOT NULL,
    external_server_id text NOT NULL,
    external_talker text NOT NULL,
    source_create_time bigint NOT NULL,
    raw_payload jsonb NOT NULL CHECK (jsonb_typeof(raw_payload) = 'object'),
    FOREIGN KEY (owner_id, contact_id, source_document_id, message_id)
        REFERENCES public.message(owner_id, contact_id, source_document_id, id)
        ON DELETE CASCADE,
    UNIQUE (source_document_id, external_local_id),
    CONSTRAINT message_contact_external_local_id_unique
        UNIQUE (owner_id, contact_id, external_local_id)
);

INSERT INTO public.wechat_message_metadata (
    message_id,
    owner_id,
    contact_id,
    source_document_id,
    external_local_id,
    external_server_id,
    external_talker,
    source_create_time,
    raw_payload
)
SELECT
    id,
    owner_id,
    contact_id,
    source_document_id,
    external_local_id,
    external_server_id,
    external_talker,
    source_create_time,
    raw_payload
FROM public.message;

ALTER TABLE public.message
    DROP COLUMN external_local_id,
    DROP COLUMN external_server_id,
    DROP COLUMN external_talker,
    DROP COLUMN source_create_time,
    DROP COLUMN raw_payload;

CREATE INDEX wechat_message_metadata_source_idx
    ON public.wechat_message_metadata (source_document_id);

COMMENT ON TABLE public.wechat_message_metadata IS
    '微信 JSONL 适配器保留的消息来源证据，不属于通用规范消息字段。';
COMMENT ON COLUMN public.message.source_locator IS
    '消息在所属来源内的稳定定位符，由输入适配器生成。';
COMMENT ON COLUMN public.message.media_placeholder IS
    '没有文字正文时保存的结构化媒体占位文本。';
COMMENT ON COLUMN public.wechat_message_metadata.raw_payload IS
    '未经删减的原始单行微信 JSON，只用于来源复核和删除，不进入回复检索。';

COMMIT;
