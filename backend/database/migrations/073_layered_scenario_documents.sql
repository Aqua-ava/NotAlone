-- 主题正文独立版本化；现有概览保持无正文合同。
CREATE TABLE public.layered_memory_state (
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    settings_generation bigint NOT NULL DEFAULT 0 CHECK (settings_generation >= 0),
    organization_generation bigint NOT NULL DEFAULT 0 CHECK (organization_generation >= 0),
    enabled boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled','ready','empty','failed','updating','stale','blocked')),
    covered_count integer NOT NULL DEFAULT 0 CHECK (covered_count >= 0),
    error_code text,
    last_action text,
    updated_at timestamptz,
    PRIMARY KEY(owner_id,contact_id),
    FOREIGN KEY(owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE
);

CREATE TABLE public.layered_memory_batch (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    settings_generation bigint NOT NULL,
    work_key text NOT NULL,
    status text NOT NULL CHECK (status IN ('running','succeeded','failed')),
    input_manifest jsonb NOT NULL,
    input_payload jsonb NOT NULL,
    output_payload jsonb,
    dependency_ids uuid[] NOT NULL,
    error_code text,
    created_at timestamptz NOT NULL,
    UNIQUE(owner_id,contact_id,work_key),
    UNIQUE(id,owner_id,contact_id),
    FOREIGN KEY(owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE
);
CREATE INDEX layered_memory_batch_dependencies ON public.layered_memory_batch USING gin(dependency_ids);
CREATE TABLE public.scenario_document_version (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    scenario_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    organization_generation bigint NOT NULL,
    schema_version integer NOT NULL CHECK (schema_version=1),
    title text NOT NULL,
    hint text NOT NULL,
    paragraphs jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    UNIQUE(owner_id,contact_id,organization_generation,scenario_id),
    FOREIGN KEY(batch_id,owner_id,contact_id) REFERENCES public.layered_memory_batch(id,owner_id,contact_id) ON DELETE CASCADE,
    FOREIGN KEY(owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE
);
COMMENT ON TABLE public.layered_memory_batch IS '有限整理实际输入输出及完整依赖；同源变化在原事务物理清除，不进入普通任务日志。';
COMMENT ON TABLE public.scenario_document_version IS '系统整理的不可变主题正文；独立于无正文概览，删除随完整批次依赖级联。';

CREATE FUNCTION public.erase_layered_memory_dependencies(affected_owner uuid, identifiers uuid[])
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    WITH erased AS (
        DELETE FROM public.layered_memory_batch
        WHERE owner_id=affected_owner AND dependency_ids && identifiers RETURNING contact_id
    )
    UPDATE public.layered_memory_state SET status=CASE WHEN enabled THEN 'stale' ELSE 'disabled' END,
        covered_count=0,error_code=NULL,organization_generation=organization_generation+1
    WHERE owner_id=affected_owner AND contact_id IN (SELECT contact_id FROM erased);
END;
$$;
CREATE FUNCTION public.invalidate_layered_memory_dependencies()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    row_data jsonb;
    old_data jsonb;
    new_data jsonb;
    identifiers uuid[];
    affected_owner uuid;
BEGIN
    IF TG_OP='UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
    IF TG_OP<>'INSERT' THEN old_data:=to_jsonb(OLD); END IF;
    IF TG_OP<>'DELETE' THEN new_data:=to_jsonb(NEW); END IF;
    FOR row_data IN SELECT value FROM jsonb_array_elements(jsonb_build_array(old_data,new_data))
        WHERE value<>'null'::jsonb LOOP
        affected_owner:=(row_data->>'owner_id')::uuid;
        PERFORM pg_advisory_xact_lock(hashtextextended('owner:'||affected_owner::text,0));
        SELECT array_agg(value::uuid) INTO identifiers FROM (
            SELECT row_data->>key AS value FROM unnest(ARRAY[
                'id','message_id','source_document_id','observation_id','source_candidate_id',
                'record_id','replacement_memory_id','source_id','trace_id']) AS key
            UNION SELECT jsonb_array_elements_text(COALESCE(row_data->'source_ids','[]'::jsonb))
        ) AS ids WHERE value IS NOT NULL;
        PERFORM public.erase_layered_memory_dependencies(affected_owner,identifiers);
    END LOOP;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER layered_memory_confirmed_memory AFTER UPDATE OR DELETE ON public.confirmed_memory
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_layered_memory_dependencies();
CREATE TRIGGER layered_memory_candidate AFTER UPDATE OR DELETE ON public.memory_candidate
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_layered_memory_dependencies();
CREATE TRIGGER layered_memory_source AFTER UPDATE OR DELETE ON public.source_document
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_layered_memory_dependencies();
CREATE TRIGGER layered_memory_message AFTER UPDATE OR DELETE ON public.message
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_layered_memory_dependencies();
CREATE TRIGGER layered_memory_reference AFTER UPDATE OR DELETE ON public.message_source_ref
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_layered_memory_dependencies();
CREATE TRIGGER layered_memory_observation AFTER UPDATE OR DELETE ON public.local_wechat_observation
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_layered_memory_dependencies();
CREATE TRIGGER layered_memory_correction AFTER INSERT OR UPDATE OR DELETE ON public.memory_correction_decision
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_layered_memory_dependencies();
CREATE TRIGGER layered_memory_trace_dependency AFTER UPDATE OR DELETE ON public.memory_extraction_trace_dependency
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_layered_memory_dependencies();
CREATE TRIGGER layered_memory_trace_link AFTER UPDATE OR DELETE ON public.memory_extraction_trace_link
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_layered_memory_dependencies();
