-- 人工决定及完整参与证据保存在原记忆生命周期内；来源删除同时清除。
CREATE FUNCTION public.notalone_correction_erased_guard_shape(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT CASE WHEN jsonb_typeof(value)='object'
        AND value->>'version'='1' AND value->>'kind'='erased_guard'
        AND jsonb_typeof(value->'canonical_ids')='array' THEN
        value - ARRAY['version','kind','canonical_ids'] = '{}'::jsonb
        AND jsonb_array_length(value->'canonical_ids') > 0
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(value->'canonical_ids') AS entry
            WHERE jsonb_typeof(entry) <> 'string'
                OR entry #>> '{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        )
        AND (SELECT count(*)=count(DISTINCT entry)
            FROM jsonb_array_elements(value->'canonical_ids') AS entry)
    ELSE false END;
$$;

CREATE TABLE public.memory_correction_decision (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    contact_id uuid,
    scope_kind text NOT NULL CHECK (scope_kind IN ('contact', 'self')),
    record_kind text NOT NULL CHECK (record_kind IN ('candidate', 'contact_memory', 'owner_memory')),
    record_id uuid NOT NULL,
    replacement_memory_id uuid,
    decision text NOT NULL CHECK (decision IN ('corrected', 'rejected')),
    rejected_text text,
    corrected_text text,
    evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object' AND evidence->>'version' = '1'),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (owner_id, contact_id) REFERENCES public.contact(owner_id, id) ON DELETE CASCADE,
    CHECK ((scope_kind = 'contact' AND contact_id IS NOT NULL) OR (scope_kind = 'self' AND contact_id IS NULL)),
    CHECK ((decision = 'corrected' AND rejected_text IS NOT NULL AND corrected_text IS NOT NULL)
        OR (decision = 'rejected' AND corrected_text IS NULL)),
    CHECK (evidence->>'kind' IS DISTINCT FROM 'erased_guard' OR (
        public.notalone_correction_erased_guard_shape(evidence)
        AND decision='rejected' AND rejected_text IS NULL AND corrected_text IS NULL
    )),
    UNIQUE (owner_id, record_kind, record_id)
);

CREATE INDEX memory_correction_decision_scope_idx
    ON public.memory_correction_decision(owner_id, contact_id, scope_kind);

ALTER TABLE public.memory_candidate
    ADD COLUMN correction_evidence jsonb,
    ADD COLUMN correction_decision_ids uuid[];

ALTER TABLE public.memory_candidate
    ADD CONSTRAINT memory_candidate_correction_evidence_check
    CHECK (correction_evidence IS NULL OR (
        jsonb_typeof(correction_evidence) = 'object'
        AND correction_evidence->>'version' = '1'
    ));
