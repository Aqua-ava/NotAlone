-- 变化只保存范围修订与时间边界；正文失效仍由原依赖清理事务负责。
ALTER TABLE public.layered_memory_state
    ADD COLUMN dirty_revision bigint NOT NULL DEFAULT 0,
    ADD COLUMN consumed_revision bigint NOT NULL DEFAULT 0,
    ADD COLUMN next_due_at timestamptz,
    ADD COLUMN next_boundary_at timestamptz,
    ADD COLUMN maintenance_allowed boolean NOT NULL DEFAULT false;
UPDATE public.layered_memory_state SET maintenance_allowed=true WHERE status IN ('ready','empty');
ALTER TABLE public.layered_memory_job ADD COLUMN target_dirty_revision bigint NOT NULL DEFAULT 0;
CREATE FUNCTION public.mark_layered_memory_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb;
BEGIN
    IF TG_OP='UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
    row_data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
    UPDATE public.layered_memory_state SET dirty_revision=dirty_revision+1,
        next_due_at=COALESCE(next_due_at,clock_timestamp()+interval '350 milliseconds')
        WHERE owner_id=(row_data->>'owner_id')::uuid AND contact_id=(row_data->>'contact_id')::uuid;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END; $$;
CREATE TRIGGER layered_memory_dirty_confirmed AFTER INSERT OR UPDATE OR DELETE ON public.confirmed_memory
    FOR EACH ROW EXECUTE FUNCTION public.mark_layered_memory_dirty();
CREATE FUNCTION public.notify_layered_memory_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status IN ('ready','empty') THEN NEW.maintenance_allowed := true;
    ELSIF NEW.status IN ('paused','failed','disabled','blocked') THEN NEW.maintenance_allowed := false;
    END IF;
    IF NEW.enabled AND (NEW.dirty_revision>NEW.consumed_revision OR NEW.next_boundary_at IS NOT NULL) THEN
        PERFORM pg_notify('layered_memory_changed',NEW.owner_id::text);
    END IF;
    RETURN NEW;
END; $$;
CREATE TRIGGER layered_memory_change_notice BEFORE UPDATE ON public.layered_memory_state
    FOR EACH ROW EXECUTE FUNCTION public.notify_layered_memory_change();

CREATE OR REPLACE FUNCTION public.erase_layered_memory_dependencies(affected_owner uuid, identifiers uuid[])
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    UPDATE public.layered_memory_state s SET dirty_revision=dirty_revision+1,
        next_due_at=COALESCE(next_due_at,clock_timestamp()+interval '350 milliseconds')
    WHERE s.owner_id=affected_owner AND (EXISTS(SELECT 1 FROM public.layered_memory_batch b
        WHERE b.owner_id=s.owner_id AND b.contact_id=s.contact_id AND b.dependency_ids && identifiers)
        OR EXISTS(SELECT 1 FROM public.layered_memory_job j WHERE j.owner_id=s.owner_id
            AND j.contact_id=s.contact_id AND j.dependency_ids && identifiers));
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
    DELETE FROM public.layered_profile_batch WHERE owner_id=affected_owner AND dependency_ids && identifiers;
    DELETE FROM public.layered_memory_generation WHERE owner_id=affected_owner AND dependency_ids && identifiers;
END; $$;
ALTER TABLE public.layered_memory_batch ADD COLUMN scenario_input jsonb NOT NULL DEFAULT '[]';
CREATE TABLE public.scenario_document_mapping (
    owner_id uuid NOT NULL, contact_id uuid NOT NULL,
    source_scenario_id uuid NOT NULL, source_version_id uuid NOT NULL,
    target_scenario_id uuid NOT NULL, target_version_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    PRIMARY KEY(source_version_id,target_version_id),
    FOREIGN KEY(batch_id,owner_id,contact_id) REFERENCES public.layered_memory_batch(id,owner_id,contact_id) ON DELETE CASCADE,
    FOREIGN KEY(target_version_id) REFERENCES public.scenario_document_version(id) ON DELETE CASCADE
);
