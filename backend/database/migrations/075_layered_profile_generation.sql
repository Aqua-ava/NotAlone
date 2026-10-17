-- 一致集合保存完整不可变主题版本；长期背景保留独立直接引用与递归依赖。
CREATE TABLE public.layered_profile_batch (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    settings_generation bigint NOT NULL,
    organization_generation bigint NOT NULL,
    work_key text NOT NULL,
    work_token uuid NOT NULL,
    budget_batch_id uuid NOT NULL,
    task_id uuid NOT NULL REFERENCES public.layered_memory_job(task_id) ON DELETE CASCADE,
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
    FOREIGN KEY(budget_batch_id,owner_id,contact_id) REFERENCES public.layered_memory_batch(id,owner_id,contact_id) ON DELETE CASCADE,
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
ALTER TABLE public.layered_memory_generation ADD FOREIGN KEY(profile_version_id,owner_id,contact_id)
    REFERENCES public.layered_profile_version(id,owner_id,contact_id) ON DELETE CASCADE;
ALTER TABLE public.layered_memory_job
    ADD COLUMN profile_required boolean NOT NULL DEFAULT false,
    ADD COLUMN profile_status text NOT NULL DEFAULT 'not_required'
        CHECK(profile_status IN ('not_required','pending','succeeded','failed'));

CREATE OR REPLACE FUNCTION public.invalidate_layered_coverage_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    active_generation bigint;
    retained uuid[];
BEGIN
    SELECT s.organization_generation,g.scenario_version_ids INTO active_generation,retained
        FROM public.layered_memory_state s JOIN public.layered_memory_generation g USING(owner_id,contact_id,organization_generation)
        WHERE s.owner_id=OLD.owner_id AND s.contact_id=OLD.contact_id AND OLD.id=ANY(g.scenario_version_ids);
    IF FOUND THEN
        retained:=array_remove(retained,OLD.id);
        IF cardinality(retained)>0 THEN
        INSERT INTO public.layered_memory_generation(owner_id,contact_id,organization_generation,schema_version,scenario_version_ids,dependency_ids)
        VALUES(OLD.owner_id,OLD.contact_id,active_generation+1,2,retained,
            ARRAY(SELECT DISTINCT unnest(b.dependency_ids) FROM public.layered_memory_batch b
                JOIN public.scenario_document_version v ON v.batch_id=b.id WHERE v.id=ANY(retained)));
        END IF;
        UPDATE public.layered_memory_state SET organization_generation=active_generation+1,
            covered_count=(SELECT count(DISTINCT item->>'memory_id') FROM public.layered_memory_batch b,
                jsonb_array_elements(b.input_manifest) item WHERE b.id IN
                    (SELECT batch_id FROM public.scenario_document_version WHERE id=ANY(retained))),
            status=CASE WHEN enabled THEN 'stale' ELSE 'disabled' END,error_code=NULL
            WHERE owner_id=OLD.owner_id AND contact_id=OLD.contact_id;
    END IF;
    DELETE FROM public.layered_memory_generation WHERE owner_id=OLD.owner_id AND contact_id=OLD.contact_id
        AND OLD.id=ANY(scenario_version_ids);
    RETURN OLD;
END; $$;

CREATE FUNCTION public.erase_layered_scenario_versions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM public.layered_profile_batch WHERE owner_id=OLD.owner_id AND contact_id=OLD.contact_id
        AND OLD.id=ANY(scenario_version_ids);
    RETURN OLD;
END;
$$;
CREATE TRIGGER layered_scenario_erase BEFORE DELETE ON public.scenario_document_version
    FOR EACH ROW EXECUTE FUNCTION public.erase_layered_scenario_versions();

CREATE OR REPLACE FUNCTION public.erase_layered_memory_dependencies(affected_owner uuid, identifiers uuid[])
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    UPDATE public.background_task SET status='cancelled',last_error_code='layered_input_changed'
    WHERE id IN (SELECT task_id FROM public.layered_memory_job
        WHERE owner_id=affected_owner AND dependency_ids && identifiers);
    UPDATE public.background_task_step SET status='cancelled',worker_id=NULL,lease_expires_at=NULL,lease_generation=lease_generation+1
        WHERE task_id IN (SELECT task_id FROM public.layered_memory_job WHERE owner_id=affected_owner AND dependency_ids && identifiers);
    WITH invalidated AS (
        UPDATE public.layered_memory_job SET state='invalidated',target_manifest='[]',dependency_ids='{}',revision=revision+1
        WHERE owner_id=affected_owner AND dependency_ids && identifiers RETURNING contact_id
    ) UPDATE public.layered_memory_state SET status=CASE WHEN enabled THEN 'stale' ELSE 'disabled' END
        WHERE owner_id=affected_owner AND contact_id IN (SELECT contact_id FROM invalidated);
    WITH erased AS (
        DELETE FROM public.layered_memory_batch
        WHERE owner_id=affected_owner AND dependency_ids && identifiers RETURNING contact_id
    )
    UPDATE public.layered_memory_state SET status=CASE WHEN enabled THEN 'stale' ELSE 'disabled' END,
        error_code=NULL
    WHERE owner_id=affected_owner AND contact_id IN (SELECT contact_id FROM erased);
    -- 先由原L2删除trigger保留未受影响主题；再清画像及旧全集，避免提前抹掉保留集合。
    DELETE FROM public.layered_profile_batch WHERE owner_id=affected_owner AND dependency_ids && identifiers;
    DELETE FROM public.layered_memory_generation WHERE owner_id=affected_owner AND dependency_ids && identifiers;
END; $$;

COMMENT ON TABLE public.layered_memory_generation IS '同范围一致版本完整集合；删除依赖由实际冻结输入推导，不作为直接依据展示。';
COMMENT ON TABLE public.layered_profile_batch IS '长期背景实际L2及底层输入、输出与完整递归依赖；来源变化物理清除。';
