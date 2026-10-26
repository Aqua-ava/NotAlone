-- 本人整理是真实owner范围；只有整理任务允许省略联系人。
ALTER TABLE public.background_task ALTER COLUMN contact_id DROP NOT NULL;
ALTER TABLE public.background_task ADD COLUMN scope_kind text GENERATED ALWAYS AS
    (CASE WHEN contact_id IS NULL THEN 'owner' ELSE 'contact' END) STORED;
ALTER TABLE public.background_task ADD CONSTRAINT background_task_owner_scope_check
    CHECK (contact_id IS NOT NULL OR (task_type='layered_memory' AND current_step='organize_memory'));
ALTER TABLE public.background_task ADD UNIQUE(id,owner_id,scope_kind);


-- 非空(kind,key)保持唯一性和跨表范围FK；contact_id仅保留真实联系人含义。
DO $$
DECLARE table_name text; constraint_row record; saved_fks jsonb := '[]'; saved_keys jsonb := '[]'; item jsonb;
    tables text[] := ARRAY['layered_memory_state','layered_memory_generation',
        'layered_memory_batch','scenario_document_version','layered_memory_job',
        'layered_profile_batch','layered_profile_version','scenario_document_mapping'];
BEGIN
    FOREACH table_name IN ARRAY tables LOOP
        EXECUTE format('ALTER TABLE public.%I ADD COLUMN scope_kind text GENERATED ALWAYS AS (CASE WHEN contact_id IS NULL THEN ''owner'' ELSE ''contact'' END) STORED NOT NULL',table_name);
        EXECUTE format('ALTER TABLE public.%I ADD COLUMN scope_key uuid GENERATED ALWAYS AS (COALESCE(contact_id,owner_id)) STORED NOT NULL',table_name);
        EXECUTE format('ALTER TABLE public.%I ADD FOREIGN KEY(owner_id) REFERENCES public.owner(id) ON DELETE CASCADE',table_name);
    END LOOP;
    -- 先保存并显式撤下受影响复合FK；不使用CASCADE静默丢弃其他约束。
    FOR constraint_row IN SELECT c.conname,c.conrelid::regclass::text AS relation,pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c JOIN pg_class parent ON parent.oid=c.confrelid
        WHERE c.contype='f' AND parent.relname=ANY(tables)
        AND pg_get_constraintdef(c.oid) LIKE '%contact_id%' LOOP
        saved_fks := saved_fks || jsonb_build_array(to_jsonb(constraint_row));
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',constraint_row.relation,constraint_row.conname);
    END LOOP;
    FOREACH table_name IN ARRAY tables LOOP
        FOR constraint_row IN SELECT c.conname,pg_get_constraintdef(c.oid) AS definition
            FROM pg_constraint c WHERE c.conrelid=('public.'||table_name)::regclass
            AND c.contype IN ('p','u') AND pg_get_constraintdef(c.oid) LIKE '%contact_id%' LOOP
            saved_keys := saved_keys || jsonb_build_array(jsonb_build_object('relation','public.'||table_name,
                'conname',constraint_row.conname,'definition',constraint_row.definition));
            EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',table_name,constraint_row.conname);
        END LOOP;
        EXECUTE format('ALTER TABLE public.%I ALTER COLUMN contact_id DROP NOT NULL',table_name);
    END LOOP;
    FOR item IN SELECT value FROM jsonb_array_elements(saved_keys || saved_fks) LOOP
        EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',item->>'relation',item->>'conname',
            replace(item->>'definition','contact_id','scope_kind, scope_key'));
    END LOOP;
END; $$;

CREATE OR REPLACE FUNCTION public.invalidate_layered_coverage_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    active_generation bigint;
    retained uuid[];
BEGIN
    SELECT s.organization_generation,g.scenario_version_ids INTO active_generation,retained
        FROM public.layered_memory_state s JOIN public.layered_memory_generation g ON s.owner_id=g.owner_id AND s.contact_id IS NOT DISTINCT FROM g.contact_id AND s.organization_generation=g.organization_generation
        WHERE s.owner_id=OLD.owner_id AND s.contact_id IS NOT DISTINCT FROM OLD.contact_id AND OLD.id=ANY(g.scenario_version_ids);
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
            WHERE owner_id=OLD.owner_id AND contact_id IS NOT DISTINCT FROM OLD.contact_id;
    END IF;
    DELETE FROM public.layered_memory_generation WHERE owner_id=OLD.owner_id AND contact_id IS NOT DISTINCT FROM OLD.contact_id
        AND OLD.id=ANY(scenario_version_ids);
    RETURN OLD;
END; $$;

CREATE OR REPLACE FUNCTION public.erase_layered_scenario_versions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM public.layered_profile_batch WHERE owner_id=OLD.owner_id AND contact_id IS NOT DISTINCT FROM OLD.contact_id
        AND OLD.id=ANY(scenario_version_ids);
    RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.erase_layered_memory_dependencies(affected_owner uuid, identifiers uuid[])
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    UPDATE public.layered_memory_state s SET dirty_revision=dirty_revision+1,
        next_due_at=COALESCE(next_due_at,clock_timestamp()+interval '350 milliseconds')
    WHERE s.owner_id=affected_owner AND (EXISTS(SELECT 1 FROM public.layered_memory_batch b
        WHERE b.owner_id=s.owner_id AND b.contact_id IS NOT DISTINCT FROM s.contact_id AND b.dependency_ids && identifiers)
        OR EXISTS(SELECT 1 FROM public.layered_memory_job j WHERE j.owner_id=s.owner_id
            AND j.contact_id IS NOT DISTINCT FROM s.contact_id AND j.dependency_ids && identifiers));
    UPDATE public.background_task SET status='cancelled',last_error_code='layered_input_changed'
    WHERE id IN (SELECT task_id FROM public.layered_memory_job
        WHERE owner_id=affected_owner AND dependency_ids && identifiers);
    UPDATE public.background_task_step SET status='cancelled',worker_id=NULL,lease_expires_at=NULL,lease_generation=lease_generation+1
        WHERE task_id IN (SELECT task_id FROM public.layered_memory_job WHERE owner_id=affected_owner AND dependency_ids && identifiers);
    WITH invalidated AS (
        UPDATE public.layered_memory_job SET state='invalidated',target_manifest='[]',dependency_ids='{}',revision=revision+1
        WHERE owner_id=affected_owner AND dependency_ids && identifiers RETURNING contact_id
    ) UPDATE public.layered_memory_state SET status=CASE WHEN enabled THEN 'stale' ELSE 'disabled' END
        WHERE owner_id=affected_owner AND EXISTS (SELECT 1 FROM invalidated affected WHERE affected.contact_id IS NOT DISTINCT FROM layered_memory_state.contact_id);
    WITH erased AS (
        DELETE FROM public.layered_memory_batch
        WHERE owner_id=affected_owner AND dependency_ids && identifiers RETURNING contact_id
    )
    UPDATE public.layered_memory_state SET status=CASE WHEN enabled THEN 'stale' ELSE 'disabled' END,
        error_code=NULL
    WHERE owner_id=affected_owner AND EXISTS (SELECT 1 FROM erased affected WHERE affected.contact_id IS NOT DISTINCT FROM layered_memory_state.contact_id);
    DELETE FROM public.layered_profile_batch WHERE owner_id=affected_owner AND dependency_ids && identifiers;
    DELETE FROM public.layered_memory_generation WHERE owner_id=affected_owner AND dependency_ids && identifiers;
END; $$;

-- 本人集合变更只合并到owner目标；原联系人来源仍沿完整依赖清理。
CREATE FUNCTION public.mark_owner_layered_memory_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected_owner uuid;
BEGIN
    affected_owner := CASE WHEN TG_OP='DELETE' THEN OLD.owner_id ELSE NEW.owner_id END;
    UPDATE public.layered_memory_state SET dirty_revision=dirty_revision+1,
        next_due_at=COALESCE(next_due_at,clock_timestamp()+interval '350 milliseconds')
        WHERE owner_id=affected_owner AND contact_id IS NULL;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END; $$;
CREATE TRIGGER owner_layered_memory_dirty AFTER INSERT OR UPDATE OR DELETE ON public.owner_memory
    FOR EACH ROW EXECUTE FUNCTION public.mark_owner_layered_memory_dirty();
CREATE TRIGGER owner_layered_memory_invalidate AFTER UPDATE OR DELETE ON public.owner_memory
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_layered_memory_dependencies();

-- job不能借另一owner或另一范围的后台任务领取许可。
ALTER TABLE public.layered_memory_job ADD FOREIGN KEY(task_id,owner_id,scope_kind)
    REFERENCES public.background_task(id,owner_id,scope_kind) ON DELETE CASCADE;
