BEGIN;

ALTER TABLE public.message
    DROP CONSTRAINT message_message_type_check,
    ADD CONSTRAINT message_message_type_check
        CHECK (
            message_type IN (
                'text',
                'quote',
                'image',
                'sticker',
                'transfer',
                'system',
                'voice',
                'voip',
                'video',
                'channel_video',
                'file',
                'link',
                'location',
                'miniprogram',
                'card',
                'red_packet',
                'forward_chat',
                'app'
            )
        );

ALTER TABLE public.wechat_message_metadata
    DROP CONSTRAINT message_contact_external_local_id_unique,
    DROP CONSTRAINT wechat_message_metadata_source_document_id_external_local_i_key,
    ADD CONSTRAINT wechat_message_metadata_source_local_time_unique
        UNIQUE (source_document_id, external_local_id, source_create_time),
    ADD CONSTRAINT wechat_message_metadata_contact_local_time_unique
        UNIQUE (owner_id, contact_id, external_local_id, source_create_time);

COMMENT ON CONSTRAINT wechat_message_metadata_contact_local_time_unique
    ON public.wechat_message_metadata IS
    '同一用户和联系人下，微信 local_id 可循环复用，但同一 local_id 与来源时间组合只能归属一个来源。';

COMMIT;
