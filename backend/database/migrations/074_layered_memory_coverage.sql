-- 首次覆盖复用既有任务租约；敏感快照只放专用派生资料表。
ALTER TABLE public.layered_memory_state DROP CONSTRAINT layered_memory_state_status_check;
ALTER TABLE public.layered_memory_state ADD CHECK(status IN ('disabled','ready','empty','failed','updating','stale','blocked','paused'));
ALTER TABLE public.background_task DROP CONSTRAINT background_task_task_type_check;
ALTER TABLE public.background_task ADD CHECK(task_type IN ('import','delete','observation','skill_learning','memory_upgrade','layered_memory'));
ALTER TABLE public.background_task DROP CONSTRAINT background_task_observation_source_check;
ALTER TABLE public.background_task ADD CONSTRAINT background_task_observation_source_check CHECK(
    (task_type IN ('observation','skill_learning','memory_upgrade','layered_memory') AND source_document_id IS NULL)
    OR (task_type IN ('import','delete') AND source_document_id IS NOT NULL));
ALTER TABLE public.background_task DROP CONSTRAINT background_task_current_step_check;
ALTER TABLE public.background_task ADD CHECK(current_step IN ('parse','normalize','extract_memory','index','verify',
    'mark_deleted','delete_derived','delete_index','clear_cache','verify_not_retrievable','propose_skill','verify_skill_drafts',
    'preview_upgrade','verify_upgrade_preview','apply_upgrade','verify_upgrade_apply','organize_memory'));
ALTER TABLE public.background_task_step DROP CONSTRAINT background_task_step_step_name_check;
ALTER TABLE public.background_task_step ADD CHECK(step_name IN ('parse','normalize','extract_memory','index','verify',
    'mark_deleted','delete_derived','delete_index','clear_cache','verify_not_retrievable','propose_skill','verify_skill_drafts',
    'preview_upgrade','verify_upgrade_preview','apply_upgrade','verify_upgrade_apply','organize_memory'));
CREATE TABLE public.layered_memory_generation (
    owner_id uuid NOT NULL, contact_id uuid NOT NULL, organization_generation bigint NOT NULL,
    schema_version integer NOT NULL CHECK(schema_version=2), scenario_version_ids uuid[] NOT NULL,
    profile_version_id uuid, dependency_ids uuid[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(owner_id,contact_id,organization_generation),
    FOREIGN KEY(owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE
);
INSERT INTO public.layered_memory_generation(owner_id,contact_id,organization_generation,schema_version,scenario_version_ids,dependency_ids)
SELECT v.owner_id,v.contact_id,v.organization_generation,2,array_agg(v.id ORDER BY v.scenario_id),
    ARRAY(SELECT DISTINCT unnest(b.dependency_ids) FROM public.layered_memory_batch b
        JOIN public.scenario_document_version d ON d.batch_id=b.id
        WHERE d.owner_id=v.owner_id AND d.contact_id=v.contact_id AND d.organization_generation=v.organization_generation)
FROM public.scenario_document_version v GROUP BY v.owner_id,v.contact_id,v.organization_generation;
CREATE TABLE public.layered_memory_job (
    task_id uuid PRIMARY KEY REFERENCES public.background_task(id) ON DELETE CASCADE,
    owner_id uuid NOT NULL, contact_id uuid NOT NULL, settings_generation bigint NOT NULL,
    target_key text NOT NULL, contract text NOT NULL, target_manifest jsonb NOT NULL, dependency_ids uuid[] NOT NULL,
    state text NOT NULL CHECK(state IN ('active','paused','failed','complete','invalidated')),
    revision bigint NOT NULL DEFAULT 1, last_action text NOT NULL DEFAULT 'start',
    batch_number integer NOT NULL DEFAULT 0, run_remaining integer NOT NULL CHECK(run_remaining>=0),
    pending_receipt boolean NOT NULL DEFAULT false,
    model_calls_used integer NOT NULL DEFAULT 0 CHECK(model_calls_used>=0), model_call_limit integer NOT NULL CHECK(model_call_limit>=0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(owner_id,contact_id,target_key),
    FOREIGN KEY(owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE
);
CREATE INDEX layered_memory_job_dependencies ON public.layered_memory_job USING gin(dependency_ids);
ALTER TABLE public.layered_memory_batch ADD COLUMN task_id uuid REFERENCES public.layered_memory_job(task_id) ON DELETE CASCADE;
ALTER TABLE public.layered_memory_batch ADD COLUMN reused_version_ids uuid[] NOT NULL DEFAULT '{}';
CREATE FUNCTION public.invalidate_layered_coverage_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    active_generation bigint;
    retained uuid[];
BEGIN
    SELECT s.organization_generation,g.scenario_version_ids INTO active_generation,retained
        FROM public.layered_memory_state s JOIN public.layered_memory_generation g USING(owner_id,contact_id,organization_generation)
        WHERE s.owner_id=OLD.owner_id AND s.contact_id=OLD.contact_id AND OLD.id=ANY(g.scenario_version_ids);
    IF FOUND THEN
        retained:=array_remove(retained,OLD.id);
        INSERT INTO public.layered_memory_generation(owner_id,contact_id,organization_generation,schema_version,scenario_version_ids,dependency_ids)
        VALUES(OLD.owner_id,OLD.contact_id,active_generation+1,2,retained,
            ARRAY(SELECT DISTINCT unnest(b.dependency_ids) FROM public.layered_memory_batch b
                JOIN public.scenario_document_version v ON v.batch_id=b.id WHERE v.id=ANY(retained)));
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
CREATE TRIGGER layered_coverage_generation_erasure BEFORE DELETE ON public.scenario_document_version
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_layered_coverage_job();
-- 目标资料尚未进入单批时也必须在来源变化时立即擦除，不能在重启中恢复旧授权。
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
END; $$;

ALTER TABLE public.layered_memory_job ADD COLUMN receipt_batch_id uuid REFERENCES public.layered_memory_batch(id) ON DELETE SET NULL;
ALTER TABLE public.layered_memory_job ADD COLUMN receipt_lease_generation bigint;

COMMENT ON TABLE public.layered_memory_generation IS '同scope完整不可变版本集合；资料变化清除受影响集合，合法主题进入新世代，画像引用不自动搬移。';
COMMENT ON TABLE public.layered_memory_job IS '用户已确认范围的首次覆盖目标、累计有限调用与精确批次回执；来源变化清除敏感快照并废止原任务。';
