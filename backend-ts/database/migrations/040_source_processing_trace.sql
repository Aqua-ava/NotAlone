-- 来源处理早于提取执行，独立留存且按来源删除清除正文。
CREATE TABLE public.source_processing_batch (
    batch_id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    source_kind text NOT NULL,
    source_id uuid,
    status text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'failed', 'deleted')),
    recorded_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    FOREIGN KEY (owner_id, contact_id) REFERENCES public.contact(owner_id, id) ON DELETE CASCADE,
    UNIQUE (batch_id, owner_id, contact_id)
);
CREATE TABLE public.source_processing_record (
    record_id uuid PRIMARY KEY,
    batch_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    position integer NOT NULL,
    locator text,
    message_id uuid,
    source_ref_id uuid,
    outcome text NOT NULL,
    payload jsonb,
    FOREIGN KEY (batch_id, owner_id, contact_id) REFERENCES public.source_processing_batch(batch_id, owner_id, contact_id) ON DELETE CASCADE,
    UNIQUE (batch_id, position)
);
CREATE INDEX source_processing_scope_idx ON public.source_processing_batch(owner_id, contact_id, recorded_at DESC);
CREATE INDEX source_processing_source_idx ON public.source_processing_batch(owner_id, contact_id, source_id);
CREATE INDEX source_processing_message_idx ON public.source_processing_record(owner_id, contact_id, message_id);
CREATE INDEX source_processing_ref_idx ON public.source_processing_record(owner_id, contact_id, source_ref_id);
