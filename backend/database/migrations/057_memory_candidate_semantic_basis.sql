BEGIN;

-- 新版本仅前向扩展约束；旧 NULL 与版本1不回填、不重采纳。
CREATE FUNCTION public.notalone_dimension_span_valid(value jsonb, message_span boolean)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE body jsonb;
BEGIN
    IF message_span THEN
        IF jsonb_typeof(value) <> 'object'
           OR NOT value ?& ARRAY['message_id','span']
           OR value - ARRAY['message_id','span'] <> '{}'::jsonb
           OR jsonb_typeof(value->'message_id') <> 'string'
           OR value->>'message_id' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        THEN RETURN false; END IF;
        body := value->'span';
    ELSE body := value;
    END IF;
    RETURN COALESCE(
        jsonb_typeof(body)='object'
        AND body ?& ARRAY['start','end','sha256']
        AND body - ARRAY['start','end','sha256']='{}'::jsonb
        AND jsonb_typeof(body->'start')='number'
        AND jsonb_typeof(body->'end')='number'
        AND body->>'start' ~ '^(0|[1-9][0-9]*)$'
        AND body->>'end' ~ '^[1-9][0-9]*$'
        AND (body->>'start')::numeric < (body->>'end')::numeric
        AND jsonb_typeof(body->'sha256')='string'
        AND body->>'sha256' ~ '^[0-9a-f]{64}$', false
    );
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

CREATE FUNCTION public.notalone_semantic_basis_v1_valid(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
    item jsonb; other jsonb; roles jsonb := '{}'::jsonb;
    atoms jsonb := '{}'::jsonb; qualifiers jsonb := '{}'::jsonb;
    identifiers text[] := '{}'; edge_keys text[] := '{}';
    identifier text; name text; kind text; predicate text; edge_key text;
    allowed text[]; required_phase text;
BEGIN
    IF value='null'::jsonb THEN RETURN true; END IF;
    IF NOT COALESCE(
        jsonb_typeof(value)='object'
        AND value ?& ARRAY['version','rule_set_sha256','rules','roles','atoms','qualifiers','reference_bindings','frame','unresolved','source_graph_sha256','candidate_graph_sha256']
        AND value - ARRAY['version','rule_set_sha256','rules','roles','atoms','qualifiers','reference_bindings','frame','unresolved','source_graph_sha256','candidate_graph_sha256']='{}'::jsonb
        AND jsonb_typeof(value->'version')='number' AND value->>'version'='1'
        AND value->>'frame' IN ('direct','quoted_request_h','received_request_h'), false
    ) THEN RETURN false; END IF;
    FOREACH name IN ARRAY ARRAY['rule_set_sha256','source_graph_sha256','candidate_graph_sha256'] LOOP
        IF jsonb_typeof(value->name)<>'string' OR value->>name !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
    END LOOP;
    FOREACH name IN ARRAY ARRAY['rules','roles','atoms','qualifiers','reference_bindings','unresolved'] LOOP
        IF jsonb_typeof(value->name)<>'array' THEN RETURN false; END IF;
        IF jsonb_array_length(value->name) > (CASE name WHEN 'rules' THEN 8 WHEN 'roles' THEN 16 WHEN 'atoms' THEN 16 WHEN 'reference_bindings' THEN 8 ELSE 32 END) THEN RETURN false; END IF;
    END LOOP;
    FOR item IN SELECT jsonb_array_elements(value->'rules') LOOP
        IF NOT COALESCE(jsonb_typeof(item)='object' AND item ?& ARRAY['rule_id','rule_version'] AND item - ARRAY['rule_id','rule_version']='{}'::jsonb
           AND item->>'rule_id' IN ('AUTHOR_ARRIVAL_H1','KIN_LEND_BA_H1','REQUEST_ROLE_H1','SOURCE_IDENTITY_H1','COND_PLAN_RUN_V1')
           AND jsonb_typeof(item->'rule_version')='number' AND item->>'rule_version'='1',false)
           OR item->>'rule_id'=ANY(identifiers) THEN RETURN false; END IF;
        identifiers := array_append(identifiers,item->>'rule_id');
    END LOOP;
    FOR item IN SELECT jsonb_array_elements(value->'roles') LOOP
        identifier := item->>'role_id'; kind := item->>'kind';
        IF NOT COALESCE(jsonb_typeof(item)='object' AND item ?& ARRAY['role_id','kind','sender','source'] AND item - ARRAY['role_id','kind','sender','source']='{}'::jsonb
           AND jsonb_typeof(item->'role_id')='number' AND identifier ~ '^(0|[1-9][0-9]*)$' AND identifier::numeric < 16
           AND kind IN ('author','elder_sister','elder_brother','colleague','vehicle','book','umbrella')
           AND ((kind='author' AND item->>'sender' IN ('self','contact')) OR (kind<>'author' AND item->'sender'='null'::jsonb))
           AND public.notalone_dimension_span_valid(item->'source',true),false)
           OR roles ? identifier THEN RETURN false; END IF;
        roles := roles || jsonb_build_object(identifier,item);
    END LOOP;
    FOR item IN SELECT jsonb_array_elements(value->'atoms') LOOP
        identifier := item->>'atom_id'; predicate := item->>'predicate';
        required_phase := CASE predicate WHEN 'arrive_home' THEN 'completed' WHEN 'lend' THEN 'completed' WHEN 'request' THEN 'historical' WHEN 'receive_request' THEN 'historical' WHEN 'cover_shift' THEN 'requested' WHEN 'run' THEN 'planned' WHEN 'clear_weather' THEN 'condition' END;
        IF NOT COALESCE(jsonb_typeof(item)='object' AND item ?& ARRAY['atom_id','predicate','phase','roles','source','candidate'] AND item - ARRAY['atom_id','predicate','phase','roles','source','candidate']='{}'::jsonb
           AND jsonb_typeof(item->'atom_id')='number' AND identifier ~ '^(0|[1-9][0-9]*)$' AND identifier::numeric < 16
           AND item->>'phase'=required_phase
           AND jsonb_typeof(item->'roles')='object' AND item->'roles' ?& ARRAY['agent','recipient','object','property_owner','beneficiary','actor']
           AND (item->'roles') - ARRAY['agent','recipient','object','property_owner','beneficiary','actor']='{}'::jsonb
           AND public.notalone_dimension_span_valid(item->'source',true) AND public.notalone_dimension_span_valid(item->'candidate',false),false)
           OR atoms ? identifier THEN RETURN false; END IF;
        FOREACH name IN ARRAY ARRAY['agent','recipient','object','property_owner','beneficiary','actor'] LOOP
            other := item->'roles'->name;
            IF other='null'::jsonb THEN CONTINUE; END IF;
            IF NOT COALESCE(jsonb_typeof(other)='number' AND other #>> '{}' ~ '^(0|[1-9][0-9]*)$' AND roles ? (other #>> '{}'),false) THEN RETURN false; END IF;
            IF (name='object') <> (roles->(other #>> '{}')->>'kind' IN ('vehicle','book','umbrella')) THEN RETURN false; END IF;
        END LOOP;
        atoms := atoms || jsonb_build_object(identifier,item);
    END LOOP;
    FOR item IN SELECT jsonb_array_elements(value->'qualifiers') LOOP
        identifier := item->>'qualifier_id'; kind := item->>'kind';
        allowed := ARRAY['qualifier_id','kind','source','candidate'] || CASE kind
          WHEN 'polarity' THEN ARRAY['atom_id','slot','value_sha256'] WHEN 'quantity' THEN ARRAY['atom_id','slot','value_sha256']
          WHEN 'time' THEN ARRAY['atom_id','slot','value_sha256'] WHEN 'degree' THEN ARRAY['quantity_qualifier_id','modifier','value_sha256']
          WHEN 'condition' THEN ARRAY['condition_atom_id','action_atom_id','relation'] ELSE NULL END;
        IF NOT COALESCE(jsonb_typeof(item)='object' AND item ?& allowed AND item - allowed='{}'::jsonb
           AND jsonb_typeof(item->'qualifier_id')='number' AND identifier ~ '^(0|[1-9][0-9]*)$' AND identifier::numeric < 32
           AND public.notalone_dimension_span_valid(item->'source',true) AND public.notalone_dimension_span_valid(item->'candidate',false),false)
           OR qualifiers ? identifier THEN RETURN false; END IF;
        IF kind<>'condition' AND NOT COALESCE(jsonb_typeof(item->'value_sha256')='string' AND item->>'value_sha256' ~ '^[0-9a-f]{64}$',false) THEN RETURN false; END IF;
        IF kind IN ('polarity','quantity','time') THEN
            name := item->>'atom_id'; predicate := atoms->name->>'predicate';
            IF NOT COALESCE(jsonb_typeof(item->'atom_id')='number' AND name ~ '^(0|[1-9][0-9]*)$' AND atoms ? name,false) THEN RETURN false; END IF;
            IF NOT COALESCE(
              (kind='polarity' AND predicate='lend' AND item->>'slot'='predicate')
              OR (kind='quantity' AND predicate='run' AND item->>'slot'='distance')
              OR (kind='time' AND ((item->>'slot'='event_time' AND predicate IN ('arrive_home','lend','run')) OR (item->>'slot'='requested_time' AND predicate='cover_shift') OR item->>'slot'='observation_time')),
              false
            ) THEN RETURN false; END IF;
            edge_key := kind || ':' || name || ':' || (item->>'slot');
        ELSIF kind='degree' THEN
            IF NOT COALESCE(jsonb_typeof(item->'quantity_qualifier_id')='number' AND item->>'quantity_qualifier_id' ~ '^(0|[1-9][0-9]*)$' AND (item->>'quantity_qualifier_id')::numeric < 32 AND item->>'modifier' IN ('only','approx'),false) THEN RETURN false; END IF;
            edge_key := kind || ':' || (item->>'quantity_qualifier_id') || ':' || (item->>'modifier');
        ELSIF kind='condition' THEN
            IF NOT COALESCE(jsonb_typeof(item->'condition_atom_id')='number' AND jsonb_typeof(item->'action_atom_id')='number'
              AND item->>'condition_atom_id' ~ '^(0|[1-9][0-9]*)$' AND item->>'action_atom_id' ~ '^(0|[1-9][0-9]*)$'
              AND item->>'relation'='requires' AND item->>'condition_atom_id' <> item->>'action_atom_id'
              AND atoms->(item->>'condition_atom_id')->>'predicate'='clear_weather' AND atoms->(item->>'action_atom_id')->>'predicate'='run',false) THEN RETURN false; END IF;
            edge_key := kind || ':' || (item->>'condition_atom_id') || ':' || (item->>'action_atom_id');
        ELSE RETURN false;
        END IF;
        IF edge_key=ANY(edge_keys) THEN RETURN false; END IF;
        edge_keys := array_append(edge_keys,edge_key);
        qualifiers := qualifiers || jsonb_build_object(identifier,item);
    END LOOP;
    FOR item IN SELECT jsonb_array_elements(value->'qualifiers') LOOP
        IF item->>'kind'='degree' AND NOT COALESCE(qualifiers->(item->>'quantity_qualifier_id')->>'kind'='quantity',false) THEN RETURN false; END IF;
    END LOOP;
    identifiers := '{}';
    FOR item IN SELECT jsonb_array_elements(value->'reference_bindings') LOOP
        identifier := item->>'role_id'; kind := roles->identifier->>'kind';
        IF NOT COALESCE(jsonb_typeof(item)='object' AND item ?& ARRAY['role_id','method','mention','target','binding'] AND item - ARRAY['role_id','method','mention','target','binding']='{}'::jsonb
          AND jsonb_typeof(item->'role_id')='number' AND identifier ~ '^(0|[1-9][0-9]*)$' AND roles ? identifier
          AND public.notalone_dimension_span_valid(item->'mention',true) AND public.notalone_dimension_span_valid(item->'target',true)
          AND item->'mention'->>'message_id'=item->'target'->>'message_id'
          AND ((item->>'method'='actual_sender' AND kind='author' AND item->'binding'='null'::jsonb AND item->'mention'=item->'target')
               OR (item->>'method'='source_identity' AND kind<>'author' AND public.notalone_dimension_span_valid(item->'binding',true) AND item->'binding'->>'message_id'=item->'mention'->>'message_id')),false)
          OR identifier=ANY(identifiers) THEN RETURN false; END IF;
        identifiers := array_append(identifiers,identifier);
    END LOOP;
    identifiers := '{}';
    FOR item IN SELECT jsonb_array_elements(value->'unresolved') LOOP
        identifier := item->>'atom_id'; name := item->>'slot'; edge_key := identifier || ':' || name;
        IF NOT COALESCE(jsonb_typeof(item)='object' AND item ?& ARRAY['atom_id','slot','source','reason'] AND item - ARRAY['atom_id','slot','source','reason']='{}'::jsonb
          AND jsonb_typeof(item->'atom_id')='number' AND identifier ~ '^(0|[1-9][0-9]*)$' AND atoms ? identifier
          AND name IN ('agent','recipient','object','property_owner','beneficiary','actor') AND atoms->identifier->'roles'->name='null'::jsonb
          AND item->>'reason' IN ('missing_source_identity','ambiguous_source','unsupported_grammar') AND public.notalone_dimension_span_valid(item->'source',true),false)
          OR edge_key=ANY(identifiers) THEN RETURN false; END IF;
        identifiers := array_append(identifiers,edge_key);
    END LOOP;
    FOR name,item IN SELECT * FROM jsonb_each(atoms) LOOP
        predicate := item->>'predicate';
        allowed := CASE predicate WHEN 'arrive_home' THEN ARRAY['actor'] WHEN 'lend' THEN ARRAY['agent','recipient','object','property_owner']
          WHEN 'request' THEN ARRAY['agent','recipient'] WHEN 'receive_request' THEN ARRAY['agent','recipient']
          WHEN 'cover_shift' THEN ARRAY['actor','beneficiary'] WHEN 'run' THEN ARRAY['actor'] ELSE ARRAY[]::text[] END;
        FOREACH kind IN ARRAY allowed LOOP
            IF item->'roles'->kind='null'::jsonb AND NOT (name || ':' || kind)=ANY(identifiers) THEN RETURN false; END IF;
        END LOOP;
    END LOOP;
    RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

CREATE FUNCTION public.notalone_dimension_evidence_v2_shape(value jsonb, candidate_length integer)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
    item jsonb; ref jsonb; anchor jsonb; position jsonb; semantic jsonb;
    message_lengths jsonb := '{}'::jsonb; names text[]; name text;
    source_positions jsonb := '[]'::jsonb; candidate_positions jsonb := '[]'::jsonb;
    identifier text;
BEGIN
    names := ARRAY['version','scope','candidate_sha256','window_sha256','pragmatics','messages','paraphrase','reference','media','reported','semantic_basis'];
    IF NOT COALESCE(jsonb_typeof(value)='object' AND value ?& names AND value - names='{}'::jsonb
        AND jsonb_typeof(value->'candidate_sha256')='string' AND value->>'candidate_sha256' ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof(value->'window_sha256')='string' AND value->>'window_sha256' ~ '^[0-9a-f]{64}$',false) THEN RETURN false; END IF;
    names := ARRAY['owner_id','contact_id'];
    IF NOT COALESCE(jsonb_typeof(value->'scope')='object' AND value->'scope' ?& names AND (value->'scope') - names='{}'::jsonb
        AND jsonb_typeof(value->'scope'->'owner_id')='string' AND jsonb_typeof(value->'scope'->'contact_id')='string',false) THEN RETURN false; END IF;
    IF value->'pragmatics'<>'null'::jsonb THEN
        names := ARRAY['speech_act','assertion_status','figurative_type'];
        IF NOT COALESCE(jsonb_typeof(value->'pragmatics')='object' AND value->'pragmatics' ?& names AND (value->'pragmatics') - names='{}'::jsonb,false) THEN RETURN false; END IF;
    END IF;
    IF NOT COALESCE(jsonb_typeof(value->'messages')='array' AND jsonb_array_length(value->'messages')>0,false) THEN RETURN false; END IF;
    FOR item IN SELECT jsonb_array_elements(value->'messages') LOOP
        names := ARRAY['message_id','text_sha256','text_length','sender','message_type','text_representation','source_state_sha256','occurred_at','source_refs'];
        identifier := item->>'message_id';
        IF NOT COALESCE(jsonb_typeof(item)='object' AND item ?& names AND item - names='{}'::jsonb
          AND jsonb_typeof(item->'message_id')='string' AND identifier ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          AND jsonb_typeof(item->'text_sha256')='string' AND item->>'text_sha256' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof(item->'text_length')='number' AND item->>'text_length' ~ '^[1-9][0-9]*$'
          AND item->>'sender' IN ('self','contact') AND jsonb_typeof(item->'message_type')='string' AND length(btrim(item->>'message_type'))>0
          AND item->>'text_representation' IN ('text','processed_text','placeholder','unknown')
          AND (item->'source_state_sha256'='null'::jsonb OR (jsonb_typeof(item->'source_state_sha256')='string' AND item->>'source_state_sha256' ~ '^[0-9a-f]{64}$'))
          AND (item->'occurred_at'='null'::jsonb OR (jsonb_typeof(item->'occurred_at')='string' AND item->>'occurred_at' ~ '.+(Z|[+-][0-9]{2}:[0-9]{2})$'))
          AND jsonb_typeof(item->'source_refs')='array',false) OR message_lengths ? identifier THEN RETURN false; END IF;
        message_lengths := message_lengths || jsonb_build_object(identifier,item->'text_length');
        FOR ref IN SELECT jsonb_array_elements(item->'source_refs') LOOP
            names := ARRAY['ref_id','source_id'];
            IF NOT COALESCE(jsonb_typeof(ref)='object' AND ref ?& names AND ref - names='{}'::jsonb
                AND jsonb_typeof(ref->'ref_id')='string' AND ref->>'ref_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                AND jsonb_typeof(ref->'source_id')='string' AND ref->>'source_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',false) THEN RETURN false; END IF;
        END LOOP;
        IF (SELECT count(*) FROM jsonb_array_elements(item->'source_refs')) <> (SELECT count(DISTINCT r->>'ref_id') FROM jsonb_array_elements(item->'source_refs') AS r) THEN RETURN false; END IF;
    END LOOP;
    FOREACH name IN ARRAY ARRAY['paraphrase','reference','media','reported'] LOOP
        IF value->name='null'::jsonb THEN CONTINUE; END IF;
        IF jsonb_typeof(value->name)<>'array' THEN RETURN false; END IF;
        FOR item IN SELECT jsonb_array_elements(value->name) LOOP
            names := CASE name WHEN 'paraphrase' THEN ARRAY['candidate','source'] WHEN 'reference' THEN ARRAY['mention','target','subject']
              WHEN 'media' THEN ARRAY['message_id','message_type','representation'] WHEN 'reported' THEN ARRAY['speaker','reported_subject','relationship'] END;
            IF NOT COALESCE(jsonb_typeof(item)='object' AND item ?& names AND item - names='{}'::jsonb,false) THEN RETURN false; END IF;
            IF name='paraphrase' THEN
                source_positions := source_positions || jsonb_build_array(item->'source');
                candidate_positions := candidate_positions || jsonb_build_array(item->'candidate');
            ELSIF name='reference' THEN
                IF NOT COALESCE(item->>'subject' IN ('self','contact','shared','unknown'),false) THEN RETURN false; END IF;
                source_positions := source_positions || jsonb_build_array(item->'mention',item->'target');
            ELSIF name='reported' THEN
                IF NOT COALESCE(item->>'relationship' IN ('direct','reported','unknown'),false) THEN RETURN false; END IF;
                source_positions := source_positions || jsonb_build_array(item->'speaker',item->'reported_subject');
            ELSE
                IF NOT COALESCE(jsonb_typeof(item->'message_id')='string' AND message_lengths ? (item->>'message_id')
                  AND jsonb_typeof(item->'message_type')='string' AND length(btrim(item->>'message_type'))>0
                  AND item->>'representation' IN ('text','processed_text','placeholder','unknown'),false) THEN RETURN false; END IF;
                IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(value->'messages') AS m WHERE m->>'message_id'=item->>'message_id' AND m->>'message_type'=item->>'message_type') THEN RETURN false; END IF;
            END IF;
        END LOOP;
    END LOOP;
    semantic := value->'semantic_basis';
    IF NOT public.notalone_semantic_basis_v1_valid(semantic) THEN RETURN false; END IF;
    IF semantic<>'null'::jsonb THEN
        FOREACH name IN ARRAY ARRAY['roles','atoms','qualifiers','unresolved'] LOOP
            FOR item IN SELECT jsonb_array_elements(semantic->name) LOOP
                source_positions := source_positions || jsonb_build_array(item->'source');
                IF name IN ('atoms','qualifiers') THEN candidate_positions := candidate_positions || jsonb_build_array(item->'candidate'); END IF;
            END LOOP;
        END LOOP;
        FOR item IN SELECT jsonb_array_elements(semantic->'reference_bindings') LOOP
            source_positions := source_positions || jsonb_build_array(item->'mention',item->'target');
            IF item->'binding'<>'null'::jsonb THEN source_positions := source_positions || jsonb_build_array(item->'binding'); END IF;
        END LOOP;
    END IF;
    FOR anchor IN SELECT jsonb_array_elements(source_positions) LOOP
        identifier := anchor->>'message_id';
        IF NOT COALESCE(public.notalone_dimension_span_valid(anchor,true) AND message_lengths ? identifier
            AND (anchor->'span'->>'end')::numeric <= (message_lengths->>identifier)::numeric,false) THEN RETURN false; END IF;
    END LOOP;
    FOR position IN SELECT jsonb_array_elements(candidate_positions) LOOP
        IF NOT COALESCE(public.notalone_dimension_span_valid(position,false) AND (position->>'end')::numeric <= candidate_length,false) THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

ALTER TABLE public.memory_candidate DROP CONSTRAINT memory_candidate_dimension_evidence_check;
ALTER TABLE public.memory_candidate ADD CONSTRAINT memory_candidate_dimension_evidence_version2_check CHECK (
    dimension_evidence IS NULL OR COALESCE(
        jsonb_typeof(dimension_evidence)='object'
        AND jsonb_typeof(dimension_evidence->'version')='number'
        AND dimension_evidence->>'version' IN ('1','2')
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
        AND (dimension_evidence->>'version'='1' OR (
            dimension_evidence ?& ARRAY['version','scope','candidate_sha256','window_sha256','pragmatics','messages','paraphrase','reference','media','reported','semantic_basis']
            AND dimension_evidence - ARRAY['version','scope','candidate_sha256','window_sha256','pragmatics','messages','paraphrase','reference','media','reported','semantic_basis']='{}'::jsonb
            AND public.notalone_dimension_evidence_v2_shape(dimension_evidence,length(text_content))
        )),false
    )
);
COMMENT ON COLUMN public.memory_candidate.dimension_evidence IS
    '版本1定位快照或版本2服务端语义关系及三锚；NULL/未解不认证质量，不存正文，不回填旧候选。';

COMMIT;
