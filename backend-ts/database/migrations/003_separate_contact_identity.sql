BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.contact)
        OR EXISTS (SELECT 1 FROM public.source_document)
        OR EXISTS (SELECT 1 FROM public.message) THEN
        RAISE EXCEPTION
            '003_separate_contact_identity requires empty contact, source_document, and message tables';
    END IF;
END
$$;

DROP TABLE public.message;
DROP TABLE public.source_document;
DROP TABLE public.contact;

CREATE TABLE public.contact (
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, id)
);

CREATE TABLE public.channel_identity (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    channel text NOT NULL CHECK (channel IN ('wechat')),
    external_id text NOT NULL CHECK (length(btrim(external_id)) > 0),
    observed_name text NOT NULL CHECK (length(btrim(observed_name)) > 0),
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked')),
    verified_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE,
    UNIQUE (owner_id, contact_id, id)
);

CREATE UNIQUE INDEX channel_identity_active_external_unique
    ON public.channel_identity (owner_id, channel, external_id)
    WHERE status = 'active';

CREATE UNIQUE INDEX channel_identity_active_contact_channel_unique
    ON public.channel_identity (owner_id, contact_id, channel)
    WHERE status = 'active';

CREATE TABLE public.source_document (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    source_type text NOT NULL CHECK (source_type IN ('wechat_jsonl')),
    file_name text NOT NULL CHECK (length(btrim(file_name)) > 0),
    content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    record_count integer NOT NULL CHECK (record_count >= 0),
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'deleting', 'deleted', 'failed')),
    imported_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE,
    UNIQUE (owner_id, contact_id, content_sha256),
    UNIQUE (owner_id, contact_id, id)
);

CREATE TABLE public.import_confirmation (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    source_document_id uuid NOT NULL UNIQUE,
    channel_identity_id uuid,
    method text NOT NULL CHECK (method IN ('manual_create', 'manual_select')),
    confirmed_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (owner_id, contact_id, source_document_id)
        REFERENCES public.source_document(owner_id, contact_id, id) ON DELETE CASCADE,
    CONSTRAINT import_confirmation_channel_identity_fk
    FOREIGN KEY (owner_id, contact_id, channel_identity_id)
        REFERENCES public.channel_identity(owner_id, contact_id, id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE public.message (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    source_document_id uuid NOT NULL,
    external_local_id bigint NOT NULL,
    external_server_id text NOT NULL,
    external_talker text NOT NULL,
    speaker text NOT NULL CHECK (speaker IN ('user', 'contact', 'system')),
    message_type text NOT NULL
        CHECK (message_type IN ('text', 'quote', 'image', 'sticker', 'transfer', 'system')),
    text_content text NOT NULL DEFAULT '',
    occurred_at timestamptz,
    source_create_time bigint NOT NULL,
    raw_payload jsonb NOT NULL CHECK (jsonb_typeof(raw_payload) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE,
    FOREIGN KEY (owner_id, contact_id, source_document_id)
        REFERENCES public.source_document(owner_id, contact_id, id) ON DELETE CASCADE,
    UNIQUE (source_document_id, external_local_id),
    CONSTRAINT message_contact_external_local_id_unique
        UNIQUE (owner_id, contact_id, external_local_id)
);

CREATE INDEX message_contact_time_idx
    ON public.message (owner_id, contact_id, occurred_at DESC, id);

CREATE INDEX message_source_idx
    ON public.message (source_document_id);

COMMIT;
