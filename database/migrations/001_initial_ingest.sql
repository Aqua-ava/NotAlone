BEGIN;

CREATE TABLE public.owner (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.contact (
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    id text NOT NULL CHECK (length(btrim(id)) > 0),
    display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, id)
);

CREATE TABLE public.source_document (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    contact_id text NOT NULL,
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

CREATE TABLE public.message (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    contact_id text NOT NULL,
    source_document_id uuid NOT NULL,
    external_message_id text NOT NULL CHECK (length(btrim(external_message_id)) > 0),
    speaker text NOT NULL CHECK (speaker IN ('user', 'contact', 'system')),
    message_type text NOT NULL
        CHECK (message_type IN ('text', 'quote', 'image', 'sticker', 'transfer', 'system')),
    text_content text NOT NULL DEFAULT '',
    occurred_at timestamptz,
    raw_payload jsonb NOT NULL CHECK (jsonb_typeof(raw_payload) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE,
    FOREIGN KEY (owner_id, contact_id, source_document_id)
        REFERENCES public.source_document(owner_id, contact_id, id) ON DELETE CASCADE,
    UNIQUE (source_document_id, external_message_id)
);

CREATE INDEX message_contact_time_idx
    ON public.message (owner_id, contact_id, occurred_at DESC, id);

CREATE INDEX message_source_idx
    ON public.message (source_document_id);

COMMIT;
