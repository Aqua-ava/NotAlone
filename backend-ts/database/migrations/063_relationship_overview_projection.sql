-- 概览只存无正文的依赖与修订，底层资料始终是权威。
CREATE FUNCTION public.notalone_overview_manifest_shape(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
    item jsonb;
    ref jsonb;
    context_record jsonb;
    key text;
    uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    memory_keys constant text[] := ARRAY['memory_id','revision','status','record_sha256',
        'timing_sha256','version_evidence_sha256','current_event_sha256',
        'version_evidence_source_current','source_generation_sha256','original_known',
        'context_records','source_ids','source_refs'];
BEGIN
    IF jsonb_typeof(value) IS DISTINCT FROM 'object'
        OR NOT value ?& ARRAY['version','memory_revision','memories']
        OR value - ARRAY['version','memory_revision','memories'] <> '{}'::jsonb
        OR value->'version' IS DISTINCT FROM '1'::jsonb
        OR jsonb_typeof(value->'memory_revision') IS DISTINCT FROM 'number'
        OR value->>'memory_revision' !~ '^[0-9]+$'
        OR jsonb_typeof(value->'memories') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    FOR item IN SELECT * FROM jsonb_array_elements(value->'memories') LOOP
        IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR NOT item ?& memory_keys
            OR item - memory_keys <> '{}'::jsonb
            OR jsonb_typeof(item->'memory_id') IS DISTINCT FROM 'string'
            OR jsonb_typeof(item->'status') IS DISTINCT FROM 'string'
            OR item->>'memory_id' !~ uuid_pattern
            OR jsonb_typeof(item->'revision') IS DISTINCT FROM 'number'
            OR item->>'revision' !~ '^[1-9][0-9]*$' OR item->>'status' NOT IN ('active','invalidated')
            OR jsonb_typeof(item->'original_known') IS DISTINCT FROM 'boolean'
            OR jsonb_typeof(item->'version_evidence_source_current') IS DISTINCT FROM 'boolean'
            OR jsonb_typeof(item->'source_ids') IS DISTINCT FROM 'array'
            OR jsonb_typeof(item->'source_refs') IS DISTINCT FROM 'array'
            OR jsonb_typeof(item->'context_records') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
        FOREACH key IN ARRAY ARRAY['record_sha256','timing_sha256','version_evidence_sha256',
                                   'current_event_sha256','source_generation_sha256'] LOOP
            IF jsonb_typeof(item->key) IS DISTINCT FROM 'string'
                OR item->>key !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
        END LOOP;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(item->'source_ids') AS identifier
            WHERE jsonb_typeof(identifier) IS DISTINCT FROM 'string'
                OR identifier #>> '{}' !~ uuid_pattern) THEN RETURN false; END IF;
        FOR ref IN SELECT * FROM jsonb_array_elements(item->'source_refs') LOOP
            IF jsonb_typeof(ref) IS DISTINCT FROM 'object'
                OR NOT ref ?& ARRAY['message_id','ref_id','source_id','digest']
                OR ref - ARRAY['message_id','ref_id','source_id','digest'] <> '{}'::jsonb
                OR EXISTS (SELECT 1 FROM jsonb_each(ref) AS field
                           WHERE jsonb_typeof(field.value) IS DISTINCT FROM 'string')
                OR ref->>'message_id' !~ uuid_pattern OR ref->>'ref_id' !~ uuid_pattern
                OR ref->>'source_id' !~ uuid_pattern OR ref->>'digest' !~ '^[0-9a-f]{64}$'
                THEN RETURN false; END IF;
        END LOOP;
        FOR context_record IN SELECT * FROM jsonb_array_elements(item->'context_records') LOOP
            IF jsonb_typeof(context_record) IS DISTINCT FROM 'object'
                OR NOT context_record ?& ARRAY['record_kind','memory_id','revision','status','record_sha256']
                OR context_record - ARRAY['record_kind','memory_id','revision','status','record_sha256'] <> '{}'::jsonb
                OR jsonb_typeof(context_record->'record_kind') IS DISTINCT FROM 'string'
                OR jsonb_typeof(context_record->'memory_id') IS DISTINCT FROM 'string'
                OR jsonb_typeof(context_record->'status') IS DISTINCT FROM 'string'
                OR jsonb_typeof(context_record->'record_sha256') IS DISTINCT FROM 'string'
                OR context_record->>'record_kind' NOT IN ('contact_memory','owner_memory')
                OR context_record->>'memory_id' !~ uuid_pattern
                OR jsonb_typeof(context_record->'revision') IS DISTINCT FROM 'number'
                OR context_record->>'revision' !~ '^[1-9][0-9]*$'
                OR context_record->>'status' NOT IN ('active','invalidated','deleted')
                OR context_record->>'record_sha256' !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
        END LOOP;
    END LOOP;
    RETURN true;
END;
$$;

CREATE TABLE public.relationship_overview_projection (
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    scope_kind text NOT NULL CHECK (scope_kind IN ('contact','owner')),
    contact_id uuid,
    projection_revision text NOT NULL CHECK (projection_revision ~ '^[0-9a-f]{64}$'),
    memory_ids uuid[] NOT NULL,
    source_ids uuid[] NOT NULL,
    manifest jsonb NOT NULL CHECK (public.notalone_overview_manifest_shape(manifest)),
    built_at timestamptz NOT NULL,
    CHECK ((scope_kind='contact' AND contact_id IS NOT NULL)
        OR (scope_kind='owner' AND contact_id IS NULL)),
    FOREIGN KEY (owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX relationship_overview_contact_unique
    ON public.relationship_overview_projection(owner_id,contact_id) WHERE scope_kind='contact';
CREATE UNIQUE INDEX relationship_overview_owner_unique
    ON public.relationship_overview_projection(owner_id) WHERE scope_kind='owner';
COMMENT ON TABLE public.relationship_overview_projection IS
    '可重建的无正文关系概览依赖；正文仅从仍合法的底层资料读取。';

-- 事务内清掉旧依赖；回滚恢复原投影，排队删除也不能留下可恢复副本。
CREATE FUNCTION public.invalidate_relationship_overview_projection()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    old_data jsonb;
    new_data jsonb;
    scope_row jsonb;
    affected_owner uuid;
    affected_contact uuid;
    identifiers uuid[];
BEGIN
    IF TG_OP='UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN
        RETURN NEW;
    END IF;
    IF TG_OP <> 'INSERT' THEN old_data := to_jsonb(OLD); END IF;
    IF TG_OP <> 'DELETE' THEN new_data := to_jsonb(NEW); END IF;
    FOR scope_row IN SELECT value FROM jsonb_array_elements(jsonb_build_array(old_data,new_data))
        WHERE value <> 'null'::jsonb LOOP
        affected_owner := (scope_row->>'owner_id')::uuid;
        affected_contact := (scope_row->>'contact_id')::uuid;
        -- 与应用 writer 的 owner 锁相同；不在 owner 锁之后申请 contact 锁。
        PERFORM pg_advisory_xact_lock(hashtextextended('owner:' || affected_owner::text,0));
        SELECT array_agg(value::uuid) INTO identifiers FROM (
            SELECT scope_row->>key AS value FROM unnest(ARRAY[
                'id','message_id','source_document_id','observation_id',
                'source_candidate_id','record_id','replacement_memory_id','source_id','trace_id']) AS key
            UNION SELECT jsonb_array_elements_text(COALESCE(scope_row->'source_ids','[]'::jsonb))
        ) AS values WHERE value IS NOT NULL;
        DELETE FROM public.relationship_overview_projection
        WHERE owner_id=affected_owner AND (scope_kind='owner' OR contact_id=affected_contact
            OR memory_ids && identifiers OR source_ids && identifiers);
    END LOOP;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER relationship_overview_confirmed_memory
    AFTER INSERT OR UPDATE OR DELETE ON public.confirmed_memory
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_relationship_overview_projection();
CREATE TRIGGER relationship_overview_memory_candidate
    AFTER INSERT OR UPDATE OR DELETE ON public.memory_candidate
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_relationship_overview_projection();
CREATE TRIGGER relationship_overview_source_document
    AFTER INSERT OR UPDATE OR DELETE ON public.source_document
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_relationship_overview_projection();
CREATE TRIGGER relationship_overview_message
    AFTER INSERT OR UPDATE OR DELETE ON public.message
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_relationship_overview_projection();
CREATE TRIGGER relationship_overview_message_source_ref
    AFTER INSERT OR UPDATE OR DELETE ON public.message_source_ref
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_relationship_overview_projection();
CREATE TRIGGER relationship_overview_local_wechat_observation
    AFTER INSERT OR UPDATE OR DELETE ON public.local_wechat_observation
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_relationship_overview_projection();
CREATE TRIGGER relationship_overview_correction_decision
    AFTER INSERT OR UPDATE OR DELETE ON public.memory_correction_decision
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_relationship_overview_projection();
CREATE TRIGGER relationship_overview_owner_memory_dependency
    AFTER INSERT OR UPDATE OR DELETE ON public.owner_memory
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_relationship_overview_projection();
CREATE TRIGGER relationship_overview_trace_dependency
    AFTER INSERT OR UPDATE OR DELETE ON public.memory_extraction_trace_dependency
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_relationship_overview_projection();
CREATE TRIGGER relationship_overview_trace_link
    AFTER INSERT OR UPDATE OR DELETE ON public.memory_extraction_trace_link
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_relationship_overview_projection();
