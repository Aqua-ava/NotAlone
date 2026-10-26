BEGIN;

ALTER TABLE public.message
    ADD CONSTRAINT message_contact_external_local_id_unique
    UNIQUE (owner_id, contact_id, external_local_id);

COMMENT ON CONSTRAINT message_contact_external_local_id_unique
    ON public.message IS
    '同一用户与联系人下，一个微信 local_id 只归属一个权威来源。';

COMMIT;
