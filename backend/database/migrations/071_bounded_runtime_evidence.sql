BEGIN;

-- 新模式只作显式前向增量；旧NULL、any及旧版本约束保持原义。
ALTER TABLE public.background_task ADD COLUMN extraction_runtime_config jsonb;
ALTER TABLE public.background_task ADD CONSTRAINT background_task_extraction_runtime_config_check CHECK (
    extraction_runtime_config IS NULL OR COALESCE(
        jsonb_typeof(extraction_runtime_config)='object'
        AND extraction_runtime_config ?& ARRAY['version','mode','rule_set_sha256']
        AND extraction_runtime_config - ARRAY['version','mode','rule_set_sha256']='{}'::jsonb
        AND jsonb_typeof(extraction_runtime_config->'version')='number'
        AND extraction_runtime_config->>'version'='1'
        AND ((extraction_runtime_config->>'mode'='legacy' AND extraction_runtime_config->'rule_set_sha256'='null'::jsonb)
          OR (extraction_runtime_config->>'mode'='bounded-runtime-v1'
            AND jsonb_typeof(extraction_runtime_config->'rule_set_sha256')='string'
            AND extraction_runtime_config->>'rule_set_sha256' ~ '^[0-9a-f]{64}$')),false)
);
ALTER TABLE public.memory_candidate ADD COLUMN source_dependency_mode text NOT NULL DEFAULT 'any';
ALTER TABLE public.memory_candidate ADD CONSTRAINT memory_candidate_source_dependency_mode_check
    CHECK (source_dependency_mode IN ('any','all'));
ALTER TABLE public.confirmed_memory ADD COLUMN source_dependency_mode text NOT NULL DEFAULT 'any';
ALTER TABLE public.confirmed_memory ADD CONSTRAINT confirmed_memory_source_dependency_mode_check
    CHECK (source_dependency_mode IN ('any','all'));
ALTER TABLE public.owner_memory ADD COLUMN source_dependency_mode text NOT NULL DEFAULT 'any';
ALTER TABLE public.owner_memory ADD CONSTRAINT owner_memory_source_dependency_mode_check
    CHECK (source_dependency_mode IN ('any','all'));

CREATE FUNCTION public.notalone_bounded_object(value jsonb, names text[])
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT COALESCE(jsonb_typeof(value)='object' AND value ?& names AND value - names='{}'::jsonb,false)
$$;
CREATE FUNCTION public.notalone_bounded_uuid(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT COALESCE(jsonb_typeof(value)='string' AND value #>> '{}' ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)
$$;
CREATE FUNCTION public.notalone_bounded_sha(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT COALESCE(jsonb_typeof(value)='string' AND value #>> '{}' ~ '^[0-9a-f]{64}$',false)
$$;
CREATE FUNCTION public.notalone_bounded_uint(value jsonb, maximum integer)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
    RETURN COALESCE(jsonb_typeof(value)='number' AND value #>> '{}' ~ '^(0|[1-9][0-9]*)$'
        AND (value #>> '{}')::numeric <= maximum,false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;
CREATE FUNCTION public.notalone_bounded_span(value jsonb, message_span boolean)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE body jsonb;
BEGIN
    IF message_span THEN
        IF NOT COALESCE(public.notalone_bounded_object(value,ARRAY['message_id','span'])
            AND public.notalone_bounded_uuid(value->'message_id'),false) THEN RETURN false; END IF;
        body := value->'span';
    ELSE body := value;
    END IF;
    RETURN COALESCE(public.notalone_bounded_object(body,ARRAY['start','end','sha256'])
        AND public.notalone_bounded_uint(body->'start',4095) AND public.notalone_bounded_uint(body->'end',4096)
        AND (body->>'start')::integer < (body->>'end')::integer
        AND public.notalone_bounded_sha(body->'sha256'),false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

-- 此函数只校形状与图内链接；当前规则SHA、正文、活动来源须由运行时独立重核。
CREATE FUNCTION public.notalone_semantic_basis_v3_valid(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
    item jsonb; other jsonb; representation jsonb; role jsonb; slots jsonb;
    roles jsonb; atoms jsonb; qualifiers jsonb; binding jsonb;
    names text[]; required text[]; name text; kind text; predicate text; rule text; frame text;
    predicate_specs jsonb := '{
        "arrive":{"phase":"completed","slots":["actor","destination"]},
        "lend":{"phase":"completed","slots":["agent","recipient","object","property_owner"]},
        "request":{"phase":"historical","slots":["agent","recipient"]},
        "receive_request":{"phase":"historical","slots":["agent","recipient"]},
        "cover_shift":{"phase":"requested","slots":["actor","beneficiary"]},
        "clear_weather":{"phase":"condition","slots":[]},
        "run":{"phase":"planned","slots":["actor"]}
    }'::jsonb;
    role_kinds text[] := ARRAY['author','elder_sister','elder_brother','colleague','vehicle','book','umbrella','home','company','school','airport','station'];
    slot_names text[] := ARRAY['agent','recipient','object','property_owner','beneficiary','actor','destination'];
    caps text[] := ARRAY['subject_binding','event_preservation','reference_resolution','direct_attribution','reported_attribution','temporal_preservation'];
    index integer; identifier integer; ordinal integer; previous integer := -1;
    kind_order integer; atom_order integer; slot_order integer; sort_key integer;
    seen text[] := '{}'; edge text; previous_edge integer := -1; quote_length integer := 0; last_end integer;
BEGIN
    names := ARRAY['version','rule_set_sha256','rules','roles','atoms','qualifiers','reference_bindings',
        'frame','unresolved','source_graph_sha256','candidate_graph_sha256','representation','capabilities'];
    IF NOT COALESCE(public.notalone_bounded_object(value,names)
        AND jsonb_typeof(value->'version')='number' AND value->>'version'='3'
        AND public.notalone_bounded_sha(value->'rule_set_sha256')
        AND public.notalone_bounded_sha(value->'source_graph_sha256')
        AND value->'source_graph_sha256'=value->'candidate_graph_sha256'
        AND value->'unresolved'='[]'::jsonb
        AND value->>'frame' IN ('direct','reported_request','received_request'),false) THEN RETURN false; END IF;
    FOREACH name IN ARRAY ARRAY['rules','roles','atoms','qualifiers','reference_bindings','capabilities'] LOOP
        IF jsonb_typeof(value->name)<>'array' THEN RETURN false; END IF;
    END LOOP;
    IF jsonb_array_length(value->'rules')<>1 OR jsonb_array_length(value->'roles') NOT BETWEEN 1 AND 16
        OR jsonb_array_length(value->'atoms') NOT BETWEEN 1 AND 16 OR jsonb_array_length(value->'qualifiers')>32
        OR jsonb_array_length(value->'reference_bindings') NOT BETWEEN 1 AND 8 THEN RETURN false; END IF;
    item := value->'rules'->0; rule := item->>'rule_id'; frame := value->>'frame';
    IF NOT COALESCE(public.notalone_bounded_object(item,ARRAY['rule_id','rule_version'])
        AND rule IN ('BR_AUTHOR_ARRIVAL_V1','BR_KIN_LEND_V1','BR_COMPLETED_QA_V1','BR_TWO_ROLES_V1','BR_REQUEST_V1','BR_COND_RUN_V1')
        AND jsonb_typeof(item->'rule_version')='number' AND item->>'rule_version'='1',false) THEN RETURN false; END IF;
    IF (rule='BR_REQUEST_V1') <> (frame<>'direct') THEN RETURN false; END IF;
    roles := value->'roles'; atoms := value->'atoms'; qualifiers := value->'qualifiers';
    FOR item,index IN SELECT v,(o-1)::integer FROM jsonb_array_elements(roles) WITH ORDINALITY AS r(v,o) LOOP
        kind := item->>'kind';
        IF NOT COALESCE(public.notalone_bounded_object(item,ARRAY['role_id','kind','owner','sender','source','candidate'])
            AND public.notalone_bounded_uint(item->'role_id',15) AND (item->>'role_id')::integer=index
            AND kind=ANY(role_kinds) AND public.notalone_bounded_span(item->'source',true)
            AND public.notalone_bounded_span(item->'candidate',false)
            AND ((kind='author' AND item->>'owner' IN ('self','contact') AND item->'sender'=item->'owner')
                OR (kind IN ('elder_sister','elder_brother','colleague') AND item->>'owner' IN ('self','contact') AND item->'sender'='null'::jsonb)
                OR (kind=ANY(role_kinds[5:12]) AND item->'owner'='null'::jsonb AND item->'sender'='null'::jsonb)),false)
            THEN RETURN false; END IF;
        ordinal := (CASE item->>'owner' WHEN 'self' THEN 0 WHEN 'contact' THEN 1 ELSE 2 END)*100 + array_position(role_kinds,kind);
        IF ordinal<=previous THEN RETURN false; END IF;
        previous := ordinal;
    END LOOP;
    FOR item,index IN SELECT v,(o-1)::integer FROM jsonb_array_elements(atoms) WITH ORDINALITY AS r(v,o) LOOP
        predicate := item->>'predicate';
        required := ARRAY(SELECT jsonb_array_elements_text(predicate_specs->predicate->'slots'));
        IF NOT COALESCE(public.notalone_bounded_object(item,ARRAY['atom_id','predicate','phase','roles','source','candidate'])
            AND public.notalone_bounded_uint(item->'atom_id',15) AND (item->>'atom_id')::integer=index
            AND item->>'phase'=(predicate_specs->predicate->>'phase')
            AND public.notalone_bounded_object(item->'roles',slot_names)
            AND public.notalone_bounded_span(item->'source',true) AND public.notalone_bounded_span(item->'candidate',false),false)
            THEN RETURN false; END IF;
        FOREACH name IN ARRAY slot_names LOOP
            other := item->'roles'->name;
            IF (name=ANY(required)) <> (other<>'null'::jsonb) THEN RETURN false; END IF;
            IF other='null'::jsonb THEN CONTINUE; END IF;
            IF NOT public.notalone_bounded_uint(other,jsonb_array_length(roles)-1) THEN RETURN false; END IF;
            kind := roles->((other #>> '{}')::integer)->>'kind';
            IF NOT ((name='object' AND kind=ANY(role_kinds[5:7]))
                OR (name='destination' AND kind=ANY(role_kinds[8:12]))
                OR (name NOT IN ('object','destination') AND kind=ANY(role_kinds[1:4]))) THEN RETURN false; END IF;
        END LOOP;
    END LOOP;
    IF NOT COALESCE(
        (rule IN ('BR_AUTHOR_ARRIVAL_V1','BR_COMPLETED_QA_V1') AND jsonb_array_length(atoms)=1 AND atoms->0->>'predicate'='arrive')
        OR (rule IN ('BR_KIN_LEND_V1','BR_TWO_ROLES_V1') AND jsonb_array_length(atoms)=1 AND atoms->0->>'predicate'='lend')
        OR (rule='BR_REQUEST_V1' AND jsonb_array_length(atoms)=2 AND atoms->1->>'predicate'='cover_shift'
            AND atoms->0->>'predicate'=CASE frame WHEN 'reported_request' THEN 'request' ELSE 'receive_request' END)
        OR (rule='BR_COND_RUN_V1' AND jsonb_array_length(atoms)=2 AND atoms->0->>'predicate'='clear_weather' AND atoms->1->>'predicate'='run'),false)
        THEN RETURN false; END IF;
    FOR item,index IN SELECT v,(o-1)::integer FROM jsonb_array_elements(qualifiers) WITH ORDINALITY AS r(v,o) LOOP
        kind := item->>'kind';
        names := ARRAY['qualifier_id','kind','source','candidate'] || CASE kind
            WHEN 'polarity' THEN ARRAY['atom_id','slot','value_sha256'] WHEN 'quantity' THEN ARRAY['atom_id','slot','value_sha256']
            WHEN 'time' THEN ARRAY['atom_id','slot','value_sha256'] WHEN 'degree' THEN ARRAY['quantity_qualifier_id','modifier','value_sha256']
            WHEN 'condition' THEN ARRAY['condition_atom_id','action_atom_id','relation'] END;
        IF NOT COALESCE(public.notalone_bounded_object(item,names) AND public.notalone_bounded_uint(item->'qualifier_id',31)
            AND (item->>'qualifier_id')::integer=index AND public.notalone_bounded_span(item->'source',true)
            AND public.notalone_bounded_span(item->'candidate',false),false) THEN RETURN false; END IF;
        kind_order := array_position(ARRAY['polarity','quantity','degree','condition','time'],kind);
        IF kind<>'condition' AND NOT public.notalone_bounded_sha(item->'value_sha256') THEN RETURN false; END IF;
        slot_order := 0;
        IF kind IN ('polarity','quantity','time') THEN
            IF NOT public.notalone_bounded_uint(item->'atom_id',jsonb_array_length(atoms)-1) THEN RETURN false; END IF;
            atom_order := (item->>'atom_id')::integer; predicate := atoms->atom_order->>'predicate';
            IF NOT COALESCE((kind='polarity' AND predicate='lend' AND item->>'slot'='predicate')
                OR (kind='quantity' AND predicate='run' AND item->>'slot'='distance')
                OR (kind='time' AND ((item->>'slot'='event_time' AND predicate IN ('arrive','lend','request','receive_request','run'))
                    OR (item->>'slot'='requested_time' AND predicate='cover_shift'))),false) THEN RETURN false; END IF;
            edge := kind || ':' || atom_order || ':' || (item->>'slot');
        ELSIF kind='degree' THEN
            IF NOT public.notalone_bounded_uint(item->'quantity_qualifier_id',jsonb_array_length(qualifiers)-1) THEN RETURN false; END IF;
            identifier := (item->>'quantity_qualifier_id')::integer;
            IF NOT COALESCE(qualifiers->identifier->>'kind'='quantity' AND item->>'modifier' IN ('only','approx'),false) THEN RETURN false; END IF;
            atom_order := (qualifiers->identifier->>'atom_id')::integer;
            slot_order := CASE item->>'modifier' WHEN 'only' THEN 0 ELSE 1 END;
            edge := kind || ':' || identifier || ':' || (item->>'modifier');
        ELSIF kind='condition' THEN
            IF NOT COALESCE(public.notalone_bounded_uint(item->'condition_atom_id',jsonb_array_length(atoms)-1)
                AND public.notalone_bounded_uint(item->'action_atom_id',jsonb_array_length(atoms)-1)
                AND (item->>'condition_atom_id')::integer < (item->>'action_atom_id')::integer
                AND atoms->((item->>'condition_atom_id')::integer)->>'predicate'='clear_weather'
                AND atoms->((item->>'action_atom_id')::integer)->>'predicate'='run' AND item->>'relation'='requires',false) THEN RETURN false; END IF;
            atom_order := (item->>'condition_atom_id')::integer;
            edge := kind || ':' || atom_order || ':' || (item->>'action_atom_id');
        ELSE RETURN false;
        END IF;
        sort_key := kind_order*10000+atom_order*10+slot_order;
        IF sort_key<previous_edge OR edge=ANY(seen) THEN RETURN false; END IF;
        previous_edge := sort_key; seen := array_append(seen,edge);
    END LOOP;
    seen := '{}'; previous_edge := -1;
    FOR binding IN SELECT jsonb_array_elements(value->'reference_bindings') LOOP
        IF NOT COALESCE(public.notalone_bounded_object(binding,ARRAY['role_id','method','mention','target','binding'])
            AND public.notalone_bounded_uint(binding->'role_id',jsonb_array_length(roles)-1)
            AND public.notalone_bounded_span(binding->'mention',true) AND public.notalone_bounded_span(binding->'target',true),false)
            THEN RETURN false; END IF;
        role := roles->((binding->>'role_id')::integer); kind := role->>'kind';
        IF NOT COALESCE((binding->>'method'='actual_sender' AND kind='author' AND binding->'mention'=binding->'target' AND binding->'binding'='null'::jsonb)
            OR (binding->>'method'='source_identity' AND kind=ANY(role_kinds[2:4]) AND public.notalone_bounded_span(binding->'binding',true))
            OR (binding->>'method'='completed_question' AND kind=ANY(role_kinds[8:12]) AND public.notalone_bounded_span(binding->'binding',true)),false)
            THEN RETURN false; END IF;
        sort_key := (binding->>'role_id')::integer*10 + array_position(ARRAY['actual_sender','source_identity','completed_question'],binding->>'method');
        IF sort_key<previous_edge OR binding::text=ANY(seen) THEN RETURN false; END IF;
        seen := array_append(seen,binding::text); previous_edge := sort_key;
    END LOOP;
    previous := 0;
    FOR item IN SELECT jsonb_array_elements(value->'capabilities') LOOP
        IF jsonb_typeof(item)<>'string' THEN RETURN false; END IF;
        ordinal := array_position(caps,item #>> '{}');
        IF ordinal IS NULL OR ordinal<=previous OR (item #>> '{}'='direct_attribution' AND frame<>'direct')
            OR (item #>> '{}'='reported_attribution' AND frame='direct') THEN RETURN false; END IF;
        previous := ordinal;
    END LOOP;
    representation := value->'representation';
    IF NOT COALESCE(public.notalone_bounded_object(representation,ARRAY['version','kind','target_message_id','source_full','whole','observation','author','quote','quote_sources','contexts'])
        AND jsonb_typeof(representation->'version')='number' AND representation->>'version'='1'
        AND representation->>'kind'='grounded_window_quote_v1' AND public.notalone_bounded_uuid(representation->'target_message_id')
        AND public.notalone_bounded_span(representation->'whole',false) AND representation->'whole'->>'start'='0'
        AND public.notalone_bounded_span(representation->'author',false) AND public.notalone_bounded_span(representation->'quote',false),false)
        THEN RETURN false; END IF;
    FOREACH name IN ARRAY ARRAY['source_full','quote_sources','contexts'] LOOP
        IF jsonb_typeof(representation->name)<>'array' THEN RETURN false; END IF;
    END LOOP;
    IF jsonb_array_length(representation->'source_full') NOT BETWEEN 1 AND 4
        OR jsonb_array_length(representation->'quote_sources') NOT BETWEEN 1 AND 2
        OR jsonb_array_length(representation->'contexts')>4 THEN RETURN false; END IF;
    seen := '{}';
    FOR item IN SELECT jsonb_array_elements(representation->'source_full') LOOP
        IF NOT COALESCE(public.notalone_bounded_span(item,true) AND item->'span'->>'start'='0',false)
            OR item->>'message_id'=ANY(seen) THEN RETURN false; END IF;
        seen := array_append(seen,item->>'message_id');
    END LOOP;
    last_end := NULL;
    FOR item IN SELECT jsonb_array_elements(representation->'quote_sources') LOOP
        IF NOT COALESCE(public.notalone_bounded_span(item,true) AND item->'message_id'=representation->'target_message_id',false)
            OR (last_end IS NOT NULL AND (item->'span'->>'start')::integer<>last_end) THEN RETURN false; END IF;
        quote_length := quote_length+(item->'span'->>'end')::integer-(item->'span'->>'start')::integer;
        last_end := (item->'span'->>'end')::integer;
    END LOOP;
    IF (representation->'quote'->>'end')::integer-(representation->'quote'->>'start')::integer<>quote_length
        OR (representation->'quote'->>'start')::integer<>(representation->'author'->>'end')::integer+4 THEN RETURN false; END IF;
    IF representation->'observation'='null'::jsonb THEN
        IF representation->'author'->>'start'<>'0' THEN RETURN false; END IF;
    ELSE
        item := representation->'observation';
        IF NOT COALESCE(public.notalone_bounded_object(item,ARRAY['message_id','candidate'])
            AND item->'message_id'=representation->'target_message_id' AND public.notalone_bounded_span(item->'candidate',false)
            AND item->'candidate'->>'start'='0' AND item->'candidate'->>'end'='13'
            AND representation->'author'->>'start'='13',false) THEN RETURN false; END IF;
    END IF;
    last_end := (representation->'quote'->>'end')::integer+1;
    seen := '{}';
    FOR item,index IN SELECT v,(o-1)::integer FROM jsonb_array_elements(representation->'contexts') WITH ORDINALITY AS r(v,o) LOOP
        IF NOT COALESCE(public.notalone_bounded_object(item,ARRAY['source','whole','author','quote'])
            AND public.notalone_bounded_span(item->'source',true) AND public.notalone_bounded_span(item->'whole',false)
            AND public.notalone_bounded_span(item->'author',false) AND public.notalone_bounded_span(item->'quote',false)
            AND item->'whole'->'start'=item->'author'->'start'
            AND (item->'whole'->>'start')::integer=last_end+CASE WHEN index=0 THEN 6 ELSE 1 END
            AND (item->'quote'->>'start')::integer=(item->'author'->>'end')::integer+2
            AND (item->'whole'->>'end')::integer=(item->'quote'->>'end')::integer+1
            AND (item->'quote'->>'end')::integer-(item->'quote'->>'start')::integer=(item->'source'->'span'->>'end')::integer-(item->'source'->'span'->>'start')::integer
            AND item->'quote'->'sha256'=item->'source'->'span'->'sha256',false) THEN RETURN false; END IF;
        edge := (item->'source'->>'message_id') || ':' || (item->'source'->'span'->>'start') || ':' || (item->'source'->'span'->>'end');
        IF edge=ANY(seen) THEN RETURN false; END IF;
        seen := array_append(seen,edge);
        last_end := (item->'whole'->>'end')::integer;
    END LOOP;
    IF (representation->'whole'->>'end')::integer<>last_end+(CASE WHEN jsonb_array_length(representation->'contexts')=0 THEN 0 ELSE 1 END)
        THEN RETURN false; END IF;
    FOR item IN SELECT jsonb_array_elements(public.notalone_bounded_basis_positions(value,true,false)) LOOP
        SELECT v INTO other FROM jsonb_array_elements(representation->'source_full') AS r(v)
            WHERE v->'message_id'=item->'message_id';
        IF NOT COALESCE((item->'span'->>'end')::integer<=(other->'span'->>'end')::integer,false) THEN RETURN false; END IF;
    END LOOP;
    FOR item IN SELECT jsonb_array_elements(public.notalone_bounded_basis_positions(value,false,false)) LOOP
        IF (item->>'end')::integer>(representation->'whole'->>'end')::integer THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

-- 统一枚举结构中的位置；source_full仅用于窗口完整性，不成为正文必需来源。
CREATE FUNCTION public.notalone_bounded_basis_positions(value jsonb, sources boolean, include_window boolean)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result jsonb := '[]'::jsonb; item jsonb; name text; rep jsonb := value->'representation';
BEGIN
    FOREACH name IN ARRAY ARRAY['roles','atoms','qualifiers'] LOOP
        FOR item IN SELECT jsonb_array_elements(value->name) LOOP
            result := result || jsonb_build_array(item->(CASE WHEN sources THEN 'source' ELSE 'candidate' END));
        END LOOP;
    END LOOP;
    IF sources THEN
        FOR item IN SELECT jsonb_array_elements(value->'reference_bindings') LOOP
            result := result || jsonb_build_array(item->'mention',item->'target');
            IF item->'binding'<>'null'::jsonb THEN result := result || jsonb_build_array(item->'binding'); END IF;
        END LOOP;
        result := result || (rep->'quote_sources');
        IF include_window THEN result := result || (rep->'source_full'); END IF;
    ELSE
        result := result || jsonb_build_array(rep->'whole',rep->'author',rep->'quote');
        IF rep->'observation'<>'null'::jsonb THEN result := result || jsonb_build_array(rep->'observation'->'candidate'); END IF;
    END IF;
    FOR item IN SELECT jsonb_array_elements(rep->'contexts') LOOP
        IF sources THEN result := result || jsonb_build_array(item->'source');
        ELSE result := result || jsonb_build_array(item->'whole',item->'author',item->'quote'); END IF;
    END LOOP;
    RETURN result;
END;
$$;

CREATE FUNCTION public.notalone_dimension_evidence_v4_shape(value jsonb, candidate_length integer)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
    item jsonb; ref jsonb; position jsonb; semantic jsonb; rep jsonb; message jsonb;
    names text[]; name text; identifier text; previous_ref text; previous_binding text; binding_key text;
    messages jsonb := '{}'::jsonb; indexes jsonb := '{}'::jsonb;
    sources jsonb := '[]'::jsonb; candidates jsonb := '[]'::jsonb;
    index integer; previous integer := -1; ordinal integer;
BEGIN
    names := ARRAY['version','scope','candidate_sha256','window_sha256','pragmatics','messages','target_message_ids',
        'paraphrase','reference','media','reported','semantic_basis'];
    IF NOT COALESCE(candidate_length BETWEEN 1 AND 4096 AND public.notalone_bounded_object(value,names)
        AND jsonb_typeof(value->'version')='number' AND value->>'version'='4'
        AND public.notalone_bounded_object(value->'scope',ARRAY['owner_id','contact_id'])
        AND public.notalone_bounded_uuid(value->'scope'->'owner_id') AND public.notalone_bounded_uuid(value->'scope'->'contact_id')
        AND public.notalone_bounded_sha(value->'candidate_sha256') AND public.notalone_bounded_sha(value->'window_sha256')
        AND value->'reference'='null'::jsonb AND value->'reported'='null'::jsonb
        AND jsonb_typeof(value->'messages')='array' AND jsonb_array_length(value->'messages') BETWEEN 1 AND 4
        AND jsonb_typeof(value->'target_message_ids')='array' AND jsonb_array_length(value->'target_message_ids') BETWEEN 1 AND 4,false)
        THEN RETURN false; END IF;
    item := value->'pragmatics';
    IF item<>'null'::jsonb AND NOT COALESCE(public.notalone_bounded_object(item,ARRAY['speech_act','assertion_status','figurative_type'])
        AND item->>'speech_act' IN ('assertion','plan','question','request','report','correction','unknown')
        AND item->>'assertion_status' IN ('asserted','hypothetical','conditional','reported','unknown')
        AND item->>'figurative_type' IN ('literal','joke','sarcasm','hyperbole','unknown'),false) THEN RETURN false; END IF;
    FOR item,index IN SELECT v,(o-1)::integer FROM jsonb_array_elements(value->'messages') WITH ORDINALITY AS r(v,o) LOOP
        identifier := item->>'message_id';
        names := ARRAY['message_id','text_sha256','text_length','sender','message_type','text_representation','source_state_sha256','occurred_at','source_refs'];
        IF NOT COALESCE(public.notalone_bounded_object(item,names) AND public.notalone_bounded_uuid(item->'message_id')
            AND public.notalone_bounded_sha(item->'text_sha256') AND public.notalone_bounded_uint(item->'text_length',4096)
            AND (item->>'text_length')::integer>0 AND item->>'sender' IN ('self','contact')
            AND jsonb_typeof(item->'message_type')='string' AND length(btrim(item->>'message_type'))>0
            AND item->>'text_representation' IN ('text','processed_text','placeholder','unknown')
            AND (item->'source_state_sha256'='null'::jsonb OR public.notalone_bounded_sha(item->'source_state_sha256'))
            AND jsonb_typeof(item->'source_refs')='array' AND jsonb_array_length(item->'source_refs')<=64,false)
            OR messages ? identifier THEN RETURN false; END IF;
        IF item->'occurred_at'<>'null'::jsonb THEN
            IF NOT COALESCE(jsonb_typeof(item->'occurred_at')='string' AND item->>'occurred_at' ~
                '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]{1,6})?)?)$',false)
                THEN RETURN false; END IF;
            PERFORM substring(item->>'occurred_at' FROM 1 FOR 10)::date;
        END IF;
        previous_ref := NULL;
        FOR ref IN SELECT jsonb_array_elements(item->'source_refs') LOOP
            IF NOT COALESCE(public.notalone_bounded_object(ref,ARRAY['ref_id','source_id'])
                AND public.notalone_bounded_uuid(ref->'ref_id') AND public.notalone_bounded_uuid(ref->'source_id'),false)
                OR (previous_ref IS NOT NULL AND ref->>'ref_id'<=previous_ref) THEN RETURN false; END IF;
            previous_ref := ref->>'ref_id';
        END LOOP;
        messages := messages || jsonb_build_object(identifier,item);
        indexes := indexes || jsonb_build_object(identifier,index);
    END LOOP;
    FOR item IN SELECT jsonb_array_elements(value->'target_message_ids') LOOP
        identifier := item #>> '{}';
        IF NOT COALESCE(public.notalone_bounded_uuid(item) AND indexes ? identifier,false) THEN RETURN false; END IF;
        ordinal := (indexes->>identifier)::integer;
        IF ordinal<=previous THEN RETURN false; END IF;
        previous := ordinal;
    END LOOP;
    IF value->'paraphrase'<>'null'::jsonb THEN
        IF jsonb_typeof(value->'paraphrase')<>'array' OR jsonb_array_length(value->'paraphrase')>16 THEN RETURN false; END IF;
        FOR item IN SELECT jsonb_array_elements(value->'paraphrase') LOOP
            IF NOT public.notalone_bounded_object(item,ARRAY['candidate','source']) THEN RETURN false; END IF;
            sources := sources || jsonb_build_array(item->'source'); candidates := candidates || jsonb_build_array(item->'candidate');
        END LOOP;
    END IF;
    IF value->'media'<>'null'::jsonb THEN
        IF jsonb_typeof(value->'media')<>'array' OR jsonb_array_length(value->'media')>4 THEN RETURN false; END IF;
        previous := -1;
        FOR item IN SELECT jsonb_array_elements(value->'media') LOOP
            identifier := item->>'message_id';
            IF NOT COALESCE(public.notalone_bounded_object(item,ARRAY['message_id','message_type','representation'])
                AND public.notalone_bounded_uuid(item->'message_id') AND messages ? identifier
                AND item->'message_type'=messages->identifier->'message_type'
                AND item->'representation'=messages->identifier->'text_representation',false) THEN RETURN false; END IF;
            ordinal := (indexes->>identifier)::integer;
            IF ordinal<=previous THEN RETURN false; END IF;
            previous := ordinal;
        END LOOP;
    END IF;
    semantic := value->'semantic_basis';
    IF semantic<>'null'::jsonb THEN
        IF NOT public.notalone_semantic_basis_v3_valid(semantic) OR value->'pragmatics'='null'::jsonb THEN RETURN false; END IF;
        FOR message IN SELECT jsonb_array_elements(value->'messages') LOOP
            IF NOT COALESCE(message->>'message_type'='text' AND message->>'text_representation'='text'
                AND public.notalone_bounded_sha(message->'source_state_sha256') AND jsonb_array_length(message->'source_refs')>0,false)
                THEN RETURN false; END IF;
        END LOOP;
        rep := semantic->'representation';
        IF NOT COALESCE(value->'target_message_ids' @> jsonb_build_array(rep->'target_message_id')
            AND jsonb_array_length(rep->'source_full')=jsonb_array_length(value->'messages')
            AND (rep->'whole'->>'end')::integer=candidate_length,false) THEN RETURN false; END IF;
        FOR item,index IN SELECT v,(o-1)::integer FROM jsonb_array_elements(rep->'source_full') WITH ORDINALITY AS r(v,o) LOOP
            message := value->'messages'->index;
            IF NOT COALESCE(item->'message_id'=message->'message_id' AND item->'span'->'end'=message->'text_length'
                AND item->'span'->'sha256'=message->'text_sha256',false) THEN RETURN false; END IF;
        END LOOP;
        message := messages->(rep->>'target_message_id');
        IF (rep->'author'->>'end')::integer-(rep->'author'->>'start')::integer
            <>(CASE message->>'sender' WHEN 'self' THEN 2 ELSE 3 END) THEN RETURN false; END IF;
        FOR item IN SELECT jsonb_array_elements(rep->'contexts') LOOP
            message := messages->(item->'source'->>'message_id');
            IF NOT COALESCE((item->'author'->>'end')::integer-(item->'author'->>'start')::integer
                =CASE message->>'sender' WHEN 'self' THEN 2 ELSE 3 END,false) THEN RETURN false; END IF;
        END LOOP;
        previous_binding := NULL;
        FOR item IN SELECT jsonb_array_elements(semantic->'reference_bindings') LOOP
            binding_key := lpad(item->>'role_id',2,'0') || array_position(ARRAY['actual_sender','source_identity','completed_question'],item->>'method')::text
                || (indexes->>(item->'mention'->>'message_id')) || lpad(item->'mention'->'span'->>'start',4,'0')
                || lpad(item->'mention'->'span'->>'end',4,'0');
            IF previous_binding IS NOT NULL AND binding_key<previous_binding THEN RETURN false; END IF;
            previous_binding := binding_key;
        END LOOP;
        sources := sources || public.notalone_bounded_basis_positions(semantic,true,true);
        candidates := candidates || public.notalone_bounded_basis_positions(semantic,false,false);
    END IF;
    FOR position IN SELECT jsonb_array_elements(sources) LOOP
        identifier := position->>'message_id';
        IF NOT COALESCE(public.notalone_bounded_span(position,true) AND messages ? identifier
            AND (position->'span'->>'end')::integer <= (messages->identifier->>'text_length')::integer,false) THEN RETURN false; END IF;
    END LOOP;
    FOR position IN SELECT jsonb_array_elements(candidates) LOOP
        IF NOT COALESCE(public.notalone_bounded_span(position,false) AND (position->>'end')::integer<=candidate_length,false) THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

CREATE FUNCTION public.notalone_bounded_evidence_sources(value jsonb, source_ids uuid[])
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE item jsonb; semantic jsonb := value->'semantic_basis'; positions jsonb := '[]'::jsonb; identifier uuid;
BEGIN
    IF cardinality(source_ids) NOT BETWEEN 1 AND 4 OR (SELECT count(DISTINCT id) FROM unnest(source_ids) AS id)<>cardinality(source_ids)
        THEN RETURN false; END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(value->'target_message_ids') AS t(id)
        WHERE id::uuid=ANY(source_ids)) THEN RETURN false; END IF;
    FOREACH identifier IN ARRAY source_ids LOOP
        IF NOT COALESCE(value->'messages' @> jsonb_build_array(jsonb_build_object('message_id',identifier::text)),false) THEN RETURN false; END IF;
    END LOOP;
    IF value->'paraphrase'<>'null'::jsonb THEN
        FOR item IN SELECT jsonb_array_elements(value->'paraphrase') LOOP positions := positions || jsonb_build_array(item->'source'); END LOOP;
    END IF;
    IF value->'media'<>'null'::jsonb THEN
        FOR item IN SELECT jsonb_array_elements(value->'media') LOOP
            IF NOT (item->>'message_id')::uuid=ANY(source_ids) THEN RETURN false; END IF;
        END LOOP;
    END IF;
    IF semantic<>'null'::jsonb THEN
        IF NOT (semantic->'representation'->>'target_message_id')::uuid=ANY(source_ids) THEN RETURN false; END IF;
        positions := positions || public.notalone_bounded_basis_positions(semantic,true,false);
    END IF;
    FOR item IN SELECT jsonb_array_elements(positions) LOOP
        IF NOT (item->>'message_id')::uuid=ANY(source_ids) THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

-- 直接保留已安装059的精确旧谓词，仅以独立v4分支前向扩展，不重解释版本1–3。
DO $$
DECLARE legacy text;
BEGIN
    SELECT pg_get_expr(conbin,conrelid) INTO STRICT legacy FROM pg_constraint
        WHERE conrelid='public.memory_candidate'::regclass AND conname='memory_candidate_dimension_evidence_version3_check';
    ALTER TABLE public.memory_candidate DROP CONSTRAINT memory_candidate_dimension_evidence_version3_check;
    EXECUTE format('ALTER TABLE public.memory_candidate ADD CONSTRAINT memory_candidate_dimension_evidence_version4_check CHECK (dimension_evidence IS NULL OR (source_dependency_mode=''any'' AND (%s)) OR COALESCE(
        source_dependency_mode=''all'' AND public.notalone_dimension_evidence_v4_shape(dimension_evidence,length(text_content))
        AND dimension_evidence->''scope''->>''owner_id''=owner_id::text
        AND dimension_evidence->''scope''->>''contact_id''=contact_id::text
        AND public.notalone_bounded_evidence_sources(dimension_evidence,source_ids),false))',legacy);
END;
$$;
COMMENT ON COLUMN public.background_task.extraction_runtime_config IS
    '指定任务的不可变提取模式配置；NULL沿旧默认，不存正文，不由迁移填充规则摘要。';
COMMENT ON COLUMN public.memory_candidate.source_dependency_mode IS
    'any沿旧替代来源；all为正文必需消息的合取依赖，清空依据不能清除此模式。';
COMMENT ON COLUMN public.confirmed_memory.source_dependency_mode IS '确认和修正版继承正文来源依赖方式；独立手动资料默认any。';
COMMENT ON COLUMN public.owner_memory.source_dependency_mode IS '本人资料保留正文来源依赖方式，不因跨联系人使用而丢失all。';
COMMENT ON COLUMN public.memory_candidate.dimension_evidence IS
    '旧版本1–3沿原合同；版本4保存有限完整窗口、实际目标及可空basis3；SQL形状不认证正文、来源、模型质量或采纳资格。';

COMMIT;
