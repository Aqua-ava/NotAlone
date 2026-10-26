-- 旧NULL保持未知，不补造发生时间、阶段或原始版本依据。
CREATE FUNCTION public.notalone_memory_event_shape(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT CASE WHEN jsonb_typeof(value)='object'
        AND value->'version'='1'::jsonb
        AND value ?& ARRAY['stage','stage_verified','stage_evidence','occurrence_start',
                          'occurrence_end','occurrence_verified','occurrence_evidence']
        AND jsonb_typeof(value->'stage_evidence')='array'
        AND jsonb_typeof(value->'occurrence_evidence')='array' THEN
        value - ARRAY['version','stage','stage_verified','stage_evidence','occurrence_start',
                      'occurrence_end','occurrence_verified','occurrence_evidence']='{}'::jsonb
        AND jsonb_typeof(value->'stage')='string'
        AND value->>'stage' IN ('planned','agreed','rescheduled','cancelled','occurred','unknown')
        AND jsonb_typeof(value->'stage_verified')='boolean'
        AND jsonb_typeof(value->'occurrence_verified')='boolean'
        AND jsonb_typeof(value->'occurrence_start') IN ('string','null')
        AND jsonb_typeof(value->'occurrence_end') IN ('string','null')
        AND NOT (value->'occurrence_start'='null'::jsonb AND value->'occurrence_end'<>'null'::jsonb)
        AND jsonb_array_length(value->'stage_evidence')<=8
        AND jsonb_array_length(value->'occurrence_evidence')<=8
        AND (value->'stage_verified'='false'::jsonb OR (
            value->>'stage'<>'unknown' AND jsonb_array_length(value->'stage_evidence')>0))
        AND (value->'occurrence_verified'='false'::jsonb OR (
            value->'occurrence_start'<>'null'::jsonb AND jsonb_array_length(value->'occurrence_evidence')>0))
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(
                (value->'stage_evidence') || (value->'occurrence_evidence')) AS item
            WHERE jsonb_typeof(item)<>'object'
                OR NOT item ?& ARRAY['message_id','char_start','char_end']
                OR item - ARRAY['message_id','char_start','char_end']<>'{}'::jsonb
                OR jsonb_typeof(item->'message_id') IS DISTINCT FROM 'string'
                OR item->>'message_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                OR jsonb_typeof(item->'char_start')<>'number'
                OR jsonb_typeof(item->'char_end')<>'number'
                OR item->>'char_start' !~ '^[0-9]+$'
                OR item->>'char_end' !~ '^[0-9]+$'
                OR CASE WHEN item->>'char_start' ~ '^[0-9]+$' AND item->>'char_end' ~ '^[0-9]+$'
                    THEN (item->>'char_start')::numeric >= (item->>'char_end')::numeric
                        OR (item->>'char_end')::numeric > 100000 ELSE true END
        )
    ELSE false END;
$$;

CREATE FUNCTION public.notalone_version_window_shape(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT CASE WHEN value='null'::jsonb THEN true
        WHEN jsonb_typeof(value)='object' AND value->'version'='1'::jsonb
        AND value ?& ARRAY['ordered_message_ids','message_ids','source_ids','source_refs',
                          'message_digests','message_snapshots','message_scopes']
        AND jsonb_typeof(value->'ordered_message_ids')='array'
        AND jsonb_typeof(value->'message_ids')='array'
        AND jsonb_typeof(value->'source_ids')='array'
        AND jsonb_typeof(value->'source_refs')='array'
        AND jsonb_typeof(value->'message_digests')='object'
        AND jsonb_typeof(value->'message_snapshots')='object'
        AND jsonb_typeof(value->'message_scopes')='object' THEN
        value - ARRAY['version','ordered_message_ids','message_ids','source_ids','source_refs',
                      'message_digests','message_snapshots','message_scopes']='{}'::jsonb
        AND jsonb_array_length(value->'message_ids') BETWEEN 1 AND 1000
        AND jsonb_array_length(value->'ordered_message_ids') BETWEEN 1 AND 1000
        AND jsonb_array_length(value->'source_ids')<=1000
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_each(value->'message_snapshots') AS snapshot
            WHERE jsonb_typeof(snapshot.value) IS DISTINCT FROM 'object'
                OR NOT snapshot.value ?& ARRAY['message_id','text_sha256','text_length','sender',
                       'message_type','occurred_at','text_representation','source_refs','source_state_sha256']
                OR snapshot.value - ARRAY['message_id','text_sha256','text_length','sender',
                       'message_type','occurred_at','text_representation','source_refs','source_state_sha256']<>'{}'::jsonb
                OR jsonb_typeof(snapshot.value->'source_refs') IS DISTINCT FROM 'array'
                OR EXISTS (
                    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(snapshot.value->'source_refs')='array'
                        THEN snapshot.value->'source_refs' ELSE '[]'::jsonb END) AS ref
                    WHERE jsonb_typeof(ref) IS DISTINCT FROM 'object'
                        OR NOT ref ?& ARRAY['ref_id','source_id'] OR ref - ARRAY['ref_id','source_id']<>'{}'::jsonb
                )
        )
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(value->'source_refs') AS ref
            WHERE jsonb_typeof(ref) IS DISTINCT FROM 'object'
                OR NOT ref ?& ARRAY['message_id','ref_id','source_id','digest']
                OR ref - ARRAY['message_id','ref_id','source_id','digest']<>'{}'::jsonb
        )
    ELSE false END;
$$;

CREATE FUNCTION public.notalone_version_evidence_shape(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT COALESCE(jsonb_typeof(value)='object' AND value->'version'='1'::jsonb
        AND value ?& ARRAY['previous','current','previous_window','current_window']
        AND value - ARRAY['version','previous','current','previous_window','current_window']='{}'::jsonb
        AND jsonb_typeof(value->'previous')='object'
        AND jsonb_typeof(value->'current')='object'
        AND value->'previous' ?& ARRAY['memory_id','revision','adoption_method','valid_at','invalid_at','record_sha256']
        AND (value->'previous') - ARRAY['memory_id','revision','adoption_method','valid_at','invalid_at','record_sha256']='{}'::jsonb
        AND value->'current' ?& ARRAY['memory_id','revision','record_sha256']
        AND (value->'current') - ARRAY['memory_id','revision','record_sha256']='{}'::jsonb
        AND value->'previous'->>'adoption_method' IN ('auto','manual')
        AND jsonb_typeof(value->'previous'->'valid_at') IN ('string','null')
        AND jsonb_typeof(value->'previous'->'invalid_at') IN ('string','null')
        AND value->'previous'->>'record_sha256' ~ '^[0-9a-f]{64}$'
        AND value->'current'->>'record_sha256' ~ '^[0-9a-f]{64}$'
        AND value->'previous'->>'revision' ~ '^[1-9][0-9]*$'
        AND value->'current'->>'revision' ~ '^[1-9][0-9]*$'
        AND jsonb_typeof(value->'previous'->'revision')='number'
        AND jsonb_typeof(value->'current'->'revision')='number'
        AND public.notalone_version_window_shape(value->'previous_window')
        AND public.notalone_version_window_shape(value->'current_window'), false);
$$;

ALTER TABLE public.memory_candidate ADD COLUMN event jsonb
    CHECK (event IS NULL OR public.notalone_memory_event_shape(event));
ALTER TABLE public.confirmed_memory ADD COLUMN event jsonb
    CHECK (event IS NULL OR public.notalone_memory_event_shape(event));
ALTER TABLE public.owner_memory ADD COLUMN event jsonb
    CHECK (event IS NULL OR public.notalone_memory_event_shape(event));
ALTER TABLE public.confirmed_memory ADD COLUMN version_evidence jsonb
    CHECK (version_evidence IS NULL OR public.notalone_version_evidence_shape(version_evidence));
ALTER TABLE public.owner_memory ADD COLUMN version_evidence jsonb
    CHECK (version_evidence IS NULL OR public.notalone_version_evidence_shape(version_evidence));
