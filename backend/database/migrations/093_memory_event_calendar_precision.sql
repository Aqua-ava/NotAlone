-- 只扩展事件JSON合同；旧事件和已有业务资料保持原样。
CREATE OR REPLACE FUNCTION public.notalone_memory_event_shape(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT CASE WHEN jsonb_typeof(value)='object'
        AND value->'version' IN ('1'::jsonb, '2'::jsonb)
        AND value ?& ARRAY['stage','stage_verified','stage_evidence','occurrence_start',
                          'occurrence_end','occurrence_verified','occurrence_evidence']
        AND jsonb_typeof(value->'stage_evidence')='array'
        AND jsonb_typeof(value->'occurrence_evidence')='array' THEN
        value - (CASE WHEN value->'version'='2'::jsonb THEN ARRAY['occurrence_precision','occurrence_expression','anchor_message_id'] ELSE ARRAY[]::text[] END) - ARRAY['version','stage','stage_verified','stage_evidence','occurrence_start',
                      'occurrence_end','occurrence_verified','occurrence_evidence']='{}'::jsonb
        AND (value->'version'='1'::jsonb OR (
            value ?& ARRAY['occurrence_precision','occurrence_expression','anchor_message_id']
            AND value->>'occurrence_precision' IN ('year','month','day','instant','unknown')
            AND jsonb_typeof(value->'occurrence_expression') IN ('string','null')
            AND (value->'occurrence_expression'='null'::jsonb OR length(value->>'occurrence_expression') BETWEEN 1 AND 256)
            AND (value->'anchor_message_id'='null'::jsonb OR value->>'anchor_message_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
            AND (value->>'occurrence_precision'<>'unknown' OR value->'occurrence_start'='null'::jsonb)))
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

