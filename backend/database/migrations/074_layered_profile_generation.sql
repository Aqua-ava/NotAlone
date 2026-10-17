-- 一致集合保存完整不可变主题版本；长期背景保留独立直接引用与递归依赖。
CREATE TABLE public.layered_profile_batch (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    settings_generation bigint NOT NULL,
    organization_generation bigint NOT NULL,
    work_key text NOT NULL,
    work_token uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('running','succeeded','failed','withdrawn')),
    attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 2),
    lease_expires_at timestamptz NOT NULL,
    scenario_version_ids uuid[] NOT NULL,
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
CREATE INDEX layered_profile_batch_dependencies ON public.layered_profile_batch USING gin(dependency_ids);
CREATE TABLE public.layered_profile_version (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    schema_version integer NOT NULL CHECK (schema_version=2),
    entries jsonb NOT NULL,
    withdrawn boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL,
    UNIQUE(id,owner_id,contact_id),
    FOREIGN KEY(batch_id,owner_id,contact_id) REFERENCES public.layered_profile_batch(id,owner_id,contact_id) ON DELETE CASCADE
);
CREATE TABLE public.layered_memory_generation (
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    organization_generation bigint NOT NULL,
    schema_version integer NOT NULL CHECK (schema_version=2),
    scenario_version_ids uuid[] NOT NULL,
    profile_version_id uuid,
    dependency_ids uuid[] NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY(owner_id,contact_id,organization_generation),
    FOREIGN KEY(owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE,
    FOREIGN KEY(profile_version_id,owner_id,contact_id) REFERENCES public.layered_profile_version(id,owner_id,contact_id) ON DELETE CASCADE
);
INSERT INTO public.layered_memory_generation
SELECT v.owner_id,v.contact_id,v.organization_generation,2,array_agg(v.id ORDER BY v.scenario_id),NULL,
       ARRAY(SELECT DISTINCT unnest(b.dependency_ids) FROM public.layered_memory_batch b
             JOIN public.scenario_document_version s ON s.batch_id=b.id
             WHERE s.owner_id=v.owner_id AND s.contact_id=v.contact_id
               AND s.organization_generation=v.organization_generation ORDER BY 1),min(v.created_at)
FROM public.scenario_document_version v GROUP BY v.owner_id,v.contact_id,v.organization_generation;

CREATE FUNCTION public.erase_layered_scenario_versions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM public.layered_profile_batch WHERE owner_id=OLD.owner_id AND contact_id=OLD.contact_id
        AND OLD.id=ANY(scenario_version_ids);
    DELETE FROM public.layered_memory_generation WHERE owner_id=OLD.owner_id AND contact_id=OLD.contact_id
        AND OLD.id=ANY(scenario_version_ids);
    RETURN OLD;
END;
$$;
CREATE TRIGGER layered_scenario_erase BEFORE DELETE ON public.scenario_document_version
    FOR EACH ROW EXECUTE FUNCTION public.erase_layered_scenario_versions();

CREATE OR REPLACE FUNCTION public.erase_layered_memory_dependencies(affected_owner uuid, identifiers uuid[])
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    WITH erased_profiles AS (
        DELETE FROM public.layered_profile_batch WHERE owner_id=affected_owner AND dependency_ids && identifiers
        RETURNING contact_id
    ), erased_generations AS (
        DELETE FROM public.layered_memory_generation WHERE owner_id=affected_owner AND dependency_ids && identifiers
        RETURNING contact_id
    ), erased_batches AS (
        DELETE FROM public.layered_memory_batch WHERE owner_id=affected_owner AND dependency_ids && identifiers
        RETURNING contact_id
    )
    UPDATE public.layered_memory_state SET status=CASE WHEN enabled THEN 'stale' ELSE 'disabled' END,
        covered_count=0,error_code=NULL,organization_generation=organization_generation+1
    WHERE owner_id=affected_owner AND contact_id IN (
        SELECT contact_id FROM erased_profiles UNION SELECT contact_id FROM erased_generations
        UNION SELECT contact_id FROM erased_batches);
END;
$$;
COMMENT ON TABLE public.layered_memory_generation IS '同范围一致版本完整集合；删除依赖由实际冻结输入推导，不作为直接依据展示。';
COMMENT ON TABLE public.layered_profile_batch IS '长期背景实际L2及底层输入、输出与完整递归依赖；来源变化物理清除。';
