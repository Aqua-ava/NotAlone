-- 整理反馈独立于正确事实；无正文保护只在旧合法依据仍存在时保留。
ALTER TABLE public.layered_memory_state ADD COLUMN correction_revision bigint NOT NULL DEFAULT 0;
CREATE TABLE public.layered_memory_feedback (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    contact_id uuid,
    scope_kind text GENERATED ALWAYS AS (CASE WHEN contact_id IS NULL THEN 'owner' ELSE 'contact' END) STORED NOT NULL,
    scope_key uuid GENERATED ALWAYS AS (COALESCE(contact_id,owner_id)) STORED NOT NULL,
    operation_id uuid NOT NULL,
    request_digest text,
    settings_generation bigint NOT NULL,
    target_kind text NOT NULL CHECK(target_kind IN ('scenario','profile')),
    version_id uuid NOT NULL,
    item_index integer NOT NULL CHECK(item_index>=0),
    reason text CHECK(length(reason)<=500),
    rejected_text text,
    input_manifest jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(input_manifest)='array'),
    dependency_ids uuid[] NOT NULL,
    protected_memory_ids uuid[] NOT NULL,
    protected_message_ids uuid[] NOT NULL,
    state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','erased_guard')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(owner_id,scope_kind,scope_key,operation_id),
    FOREIGN KEY(owner_id,scope_kind,scope_key) REFERENCES public.layered_memory_state(owner_id,scope_kind,scope_key) ON DELETE CASCADE,
    FOREIGN KEY(contact_id,owner_id) REFERENCES public.contact(id,owner_id) ON DELETE CASCADE,
    CHECK(state='active' OR (reason IS NULL AND rejected_text IS NULL AND input_manifest='[]' AND cardinality(dependency_ids)=0))
);

-- 从产生时接入原事务：来源排队删除、旧资料变化都先清敏感反馈及对照。
ALTER FUNCTION public.erase_layered_memory_dependencies(uuid,uuid[]) RENAME TO erase_layered_memory_dependencies_v77;
CREATE FUNCTION public.erase_layered_memory_dependencies(affected_owner uuid, identifiers uuid[])
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    WITH erased AS (
        UPDATE public.layered_memory_feedback SET reason=NULL,rejected_text=NULL,request_digest=NULL,
            input_manifest='[]',dependency_ids='{}',state='erased_guard'
        WHERE owner_id=affected_owner AND dependency_ids && identifiers RETURNING contact_id
    ) UPDATE public.layered_memory_state s SET correction_revision=correction_revision+1,
        organization_generation=organization_generation+1,dirty_revision=dirty_revision+1,
        next_due_at=COALESCE(next_due_at,clock_timestamp()+interval '350 milliseconds')
        WHERE s.owner_id=affected_owner AND EXISTS(SELECT 1 FROM erased e WHERE e.contact_id IS NOT DISTINCT FROM s.contact_id);
    PERFORM public.erase_layered_memory_dependencies_v77(affected_owner,identifiers);
    DELETE FROM public.layered_memory_feedback f WHERE f.owner_id=affected_owner AND f.state='erased_guard'
        AND NOT EXISTS(SELECT 1 FROM public.message_source_ref r WHERE r.owner_id=f.owner_id
            AND r.message_id=ANY(f.protected_message_ids) AND (
                EXISTS(SELECT 1 FROM public.source_document d WHERE d.id=r.source_document_id AND d.status='active') OR
                EXISTS(SELECT 1 FROM public.local_wechat_observation o WHERE o.id=r.observation_id)))
        AND NOT EXISTS(SELECT 1 FROM public.confirmed_memory m WHERE m.owner_id=f.owner_id AND m.id=ANY(f.protected_memory_ids))
        AND NOT EXISTS(SELECT 1 FROM public.owner_memory m WHERE m.owner_id=f.owner_id AND m.id=ANY(f.protected_memory_ids));
END; $$;
