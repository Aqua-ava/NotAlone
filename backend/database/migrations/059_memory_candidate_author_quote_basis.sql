BEGIN;

-- 单独校验新版本的有限到达图；不改旧校验器，也不把新图转换成旧依据。
CREATE FUNCTION public.notalone_semantic_basis_v2_valid(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
    names text[]; name text; role jsonb; atom jsonb; qualifier jsonb; binding jsonb;
    representation jsonb; source jsonb; whole jsonb; author jsonb; inner_span jsonb;
    event_span jsonb; source_author jsonb; source_time jsonb; candidate_time jsonb;
BEGIN
    names := ARRAY['version','rule_set_sha256','rules','roles','atoms','qualifiers','reference_bindings',
                   'frame','unresolved','source_graph_sha256','candidate_graph_sha256','representation','capabilities'];
    IF NOT COALESCE(jsonb_typeof(value)='object' AND value ?& names AND value - names='{}'::jsonb
        AND jsonb_typeof(value->'version')='number' AND value->>'version'='2'
        AND value->>'frame'='direct' AND value->'unresolved'='[]'::jsonb
        AND value->'capabilities'='["author_binding","arrival_event_preservation","author_self_reference","direct_attribution","recency_preservation"]'::jsonb
        AND value->'source_graph_sha256'=value->'candidate_graph_sha256',false) THEN RETURN false; END IF;
    FOREACH name IN ARRAY ARRAY['rule_set_sha256','source_graph_sha256','candidate_graph_sha256'] LOOP
        IF NOT COALESCE(jsonb_typeof(value->name)='string' AND value->>name ~ '^[0-9a-f]{64}$',false) THEN RETURN false; END IF;
    END LOOP;
    IF NOT COALESCE(value->'rules'='[{"rule_id":"AUTHOR_ARRIVAL_H1","rule_version":2}]'::jsonb
        AND value->'rules'->0->>'rule_version'='2',false) THEN RETURN false; END IF;
    FOREACH name IN ARRAY ARRAY['roles','atoms','qualifiers','reference_bindings'] LOOP
        IF NOT COALESCE(jsonb_typeof(value->name)='array' AND jsonb_array_length(value->name)=1,false) THEN RETURN false; END IF;
    END LOOP;
    role := value->'roles'->0; atom := value->'atoms'->0;
    qualifier := value->'qualifiers'->0; binding := value->'reference_bindings'->0;
    names := ARRAY['role_id','kind','sender','source'];
    IF NOT COALESCE(jsonb_typeof(role)='object' AND role ?& names AND role - names='{}'::jsonb
        AND jsonb_typeof(role->'role_id')='number' AND role->>'role_id'='0'
        AND role->>'kind'='author' AND role->>'sender' IN ('self','contact')
        AND public.notalone_dimension_span_valid(role->'source',true),false) THEN RETURN false; END IF;
    names := ARRAY['atom_id','predicate','phase','roles','source','candidate'];
    IF NOT COALESCE(jsonb_typeof(atom)='object' AND atom ?& names AND atom - names='{}'::jsonb
        AND jsonb_typeof(atom->'atom_id')='number' AND atom->>'atom_id'='0'
        AND atom->>'predicate'='arrive_home' AND atom->>'phase'='completed'
        AND atom->'roles'='{"agent":null,"recipient":null,"object":null,"property_owner":null,"beneficiary":null,"actor":0}'::jsonb
        AND atom->'roles'->>'actor'='0'
        AND public.notalone_dimension_span_valid(atom->'source',true)
        AND public.notalone_dimension_span_valid(atom->'candidate',false),false) THEN RETURN false; END IF;
    names := ARRAY['qualifier_id','kind','atom_id','slot','value_sha256','source','candidate'];
    IF NOT COALESCE(jsonb_typeof(qualifier)='object' AND qualifier ?& names AND qualifier - names='{}'::jsonb
        AND jsonb_typeof(qualifier->'qualifier_id')='number' AND qualifier->>'qualifier_id'='0'
        AND jsonb_typeof(qualifier->'atom_id')='number' AND qualifier->>'atom_id'='0'
        AND qualifier->>'kind'='time' AND qualifier->>'slot'='event_time'
        AND qualifier->>'value_sha256'='480def19e4874d52e6e69c9c97f272fad0a1644dce859a0f41d2b94c98fb2a46'
        AND public.notalone_dimension_span_valid(qualifier->'source',true)
        AND public.notalone_dimension_span_valid(qualifier->'candidate',false),false) THEN RETURN false; END IF;
    names := ARRAY['role_id','method','mention','target','binding'];
    IF NOT COALESCE(jsonb_typeof(binding)='object' AND binding ?& names AND binding - names='{}'::jsonb
        AND jsonb_typeof(binding->'role_id')='number' AND binding->>'role_id'='0'
        AND binding->>'method'='actual_sender' AND binding->'binding'='null'::jsonb
        AND binding->'mention'=role->'source' AND binding->'target'=role->'source',false) THEN RETURN false; END IF;
    representation := value->'representation';
    names := ARRAY['version','kind','source','candidate','author','inner'];
    IF NOT COALESCE(jsonb_typeof(representation)='object' AND representation ?& names AND representation - names='{}'::jsonb
        AND jsonb_typeof(representation->'version')='number' AND representation->>'version'='1'
        AND representation->>'kind'='author_quote_h1'
        AND public.notalone_dimension_span_valid(representation->'source',true)
        AND public.notalone_dimension_span_valid(representation->'candidate',false)
        AND public.notalone_dimension_span_valid(representation->'author',false)
        AND public.notalone_dimension_span_valid(representation->'inner',false),false) THEN RETURN false; END IF;
    source := representation->'source'->'span'; whole := representation->'candidate';
    author := representation->'author'; inner_span := representation->'inner';
    event_span := atom->'source'->'span'; source_author := role->'source'->'span';
    source_time := qualifier->'source'->'span'; candidate_time := qualifier->'candidate';
    RETURN COALESCE(
        whole->>'start'=author->>'start'
        AND (author->>'end')::numeric - (author->>'start')::numeric = CASE role->>'sender' WHEN 'self' THEN 2 ELSE 3 END
        AND (inner_span->>'start')::numeric = (author->>'end')::numeric + 4
        AND (whole->>'end')::numeric = (inner_span->>'end')::numeric + 1
        AND (inner_span->>'end')::numeric - (inner_span->>'start')::numeric = (source->>'end')::numeric - (source->>'start')::numeric
        AND inner_span->'sha256'=source->'sha256' AND atom->'candidate'=whole
        AND atom->'source'->'message_id'=representation->'source'->'message_id'
        AND role->'source'->'message_id'=representation->'source'->'message_id'
        AND qualifier->'source'->'message_id'=representation->'source'->'message_id'
        AND event_span->>'start'=source->>'start'
        AND (source->>'end')::numeric - (event_span->>'end')::numeric IN (0,1)
        AND source_author->>'start'=source->>'start'
        AND (source_author->>'end')::numeric = (source->>'start')::numeric + 1
        AND source_time->>'start'=source_author->>'end'
        AND (source_time->>'end')::numeric - (source_time->>'start')::numeric IN (1,2)
        AND (event_span->>'end')::numeric = (source_time->>'end')::numeric + 2
        AND (candidate_time->>'start')::numeric = (inner_span->>'start')::numeric + (source_time->>'start')::numeric - (source->>'start')::numeric
        AND (candidate_time->>'end')::numeric = (inner_span->>'start')::numeric + (source_time->>'end')::numeric - (source->>'start')::numeric
        AND candidate_time->'sha256'=source_time->'sha256',false
    );
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

-- null投影只复用共同窗口和旧锚的结构检查，不签发或重解释任何语义依据。
CREATE FUNCTION public.notalone_dimension_evidence_v3_shape(value jsonb, candidate_length integer)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE semantic jsonb; message jsonb; position jsonb;
BEGIN
    IF NOT COALESCE(jsonb_typeof(value->'version')='number' AND value->>'version'='3'
        AND public.notalone_dimension_evidence_v2_shape(value || '{"semantic_basis":null}'::jsonb, candidate_length),false)
        THEN RETURN false; END IF;
    semantic := value->'semantic_basis';
    IF semantic='null'::jsonb THEN RETURN true; END IF;
    IF NOT public.notalone_semantic_basis_v2_valid(semantic) THEN RETURN false; END IF;
    IF jsonb_array_length(value->'messages')<>1 THEN RETURN false; END IF;
    message := value->'messages'->0;
    IF NOT COALESCE(message->>'message_type'='text' AND message->>'text_representation'='text'
        AND jsonb_typeof(message->'source_state_sha256')='string'
        AND jsonb_array_length(message->'source_refs')>0
        AND message->'sender'=semantic->'roles'->0->'sender'
        AND message->'message_id'=semantic->'representation'->'source'->'message_id'
        AND value->'pragmatics'='{"speech_act":"assertion","assertion_status":"asserted","figurative_type":"literal"}'::jsonb,false)
        THEN RETURN false; END IF;
    FOR position IN SELECT jsonb_array_elements(jsonb_build_array(
        semantic->'roles'->0->'source',semantic->'atoms'->0->'source',
        semantic->'qualifiers'->0->'source',semantic->'representation'->'source'
    )) LOOP
        IF NOT COALESCE(position->'message_id'=message->'message_id'
            AND (position->'span'->>'end')::numeric <= (message->>'text_length')::numeric,false) THEN RETURN false; END IF;
    END LOOP;
    RETURN COALESCE((semantic->'representation'->'candidate'->>'end')::numeric <= candidate_length,false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

ALTER TABLE public.memory_candidate DROP CONSTRAINT memory_candidate_dimension_evidence_version2_check;
ALTER TABLE public.memory_candidate ADD CONSTRAINT memory_candidate_dimension_evidence_version3_check CHECK (
    dimension_evidence IS NULL OR COALESCE(
        jsonb_typeof(dimension_evidence)='object'
        AND jsonb_typeof(dimension_evidence->'version')='number'
        AND dimension_evidence->>'version' IN ('1','2','3')
        AND jsonb_typeof(dimension_evidence->'scope')='object'
        AND dimension_evidence->'scope'->>'owner_id'=owner_id::text
        AND dimension_evidence->'scope'->>'contact_id'=contact_id::text
        AND dimension_evidence->>'candidate_sha256' ~ '^[0-9a-f]{64}$'
        AND dimension_evidence->>'window_sha256' ~ '^[0-9a-f]{64}$'
        AND (jsonb_typeof(dimension_evidence->'pragmatics')='null' OR (
            jsonb_typeof(dimension_evidence->'pragmatics')='object'
            AND dimension_evidence->'pragmatics'->>'speech_act' IN ('assertion','plan','question','request','report','correction','unknown')
            AND dimension_evidence->'pragmatics'->>'assertion_status' IN ('asserted','hypothetical','conditional','reported','unknown')
            AND dimension_evidence->'pragmatics'->>'figurative_type' IN ('literal','joke','sarcasm','hyperbole','unknown')
        ))
        AND jsonb_typeof(dimension_evidence->'messages')='array'
        AND jsonb_typeof(dimension_evidence->'paraphrase') IN ('array','null')
        AND jsonb_typeof(dimension_evidence->'reference') IN ('array','null')
        AND jsonb_typeof(dimension_evidence->'media') IN ('array','null')
        AND jsonb_typeof(dimension_evidence->'reported') IN ('array','null')
        AND (
            dimension_evidence->>'version'='1'
            OR (dimension_evidence->>'version'='2'
                AND public.notalone_dimension_evidence_v2_shape(dimension_evidence,length(text_content)))
            OR (dimension_evidence->>'version'='3'
                AND public.notalone_dimension_evidence_v3_shape(dimension_evidence,length(text_content))
                AND (dimension_evidence->'semantic_basis'='null'::jsonb OR (
                    category='common_fact' AND valid_at IS NULL AND invalid_at IS NULL
                    AND dimension_evidence->'semantic_basis'->'roles'->0->>'sender'=subject
                    AND cardinality(source_ids)=1
                    AND (dimension_evidence->'semantic_basis'->'representation'->'source'->>'message_id')::uuid=ANY(source_ids)
                )))
        ),false
    )
);
COMMENT ON COLUMN public.memory_candidate.dimension_evidence IS
    '版本1定位、版本2旧语义图或版本3有限作者引句图；NULL/未解不认证质量，无正文，不回填旧候选。';

COMMIT;
