-- 质量输入从第一份产物起保留完整参与依赖，模型只见范围白名单。
CREATE TABLE public.organization_quality_case (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    contact_id uuid,
    settings_generation bigint NOT NULL,
    contract_id text NOT NULL,
    contract jsonb NOT NULL,
    input_sha256 text NOT NULL,
    input_manifest jsonb NOT NULL,
    model_input jsonb NOT NULL,
    construction jsonb NOT NULL,
    dependency_ids uuid[] NOT NULL,
    review_status text NOT NULL DEFAULT 'unknown',
    annotations jsonb,
    output_payload jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY(owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE
);
CREATE INDEX organization_quality_case_dependencies ON public.organization_quality_case USING gin(dependency_ids);
CREATE FUNCTION public.erase_organization_quality_dependencies() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb; identifiers uuid[]; affected_owner uuid;
BEGIN
    IF TG_OP='UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
    FOR row_data IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
        CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
        CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END)) WHERE value<>'null'::jsonb LOOP
        affected_owner:=(row_data->>'owner_id')::uuid;
        PERFORM pg_advisory_xact_lock(hashtextextended('owner:'||affected_owner::text,0));
        SELECT array_agg(value::uuid) INTO identifiers FROM (
            SELECT row_data->>key AS value FROM unnest(ARRAY['id','message_id','source_document_id',
                'observation_id','source_candidate_id','record_id','replacement_memory_id','source_id','trace_id']) AS key
            UNION SELECT jsonb_array_elements_text(COALESCE(row_data->'source_ids','[]'::jsonb))
        ) AS ids WHERE value IS NOT NULL;
        DELETE FROM public.organization_quality_case WHERE owner_id=affected_owner AND dependency_ids && identifiers;
    END LOOP;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END; $$;
DO $$ DECLARE name text; BEGIN
    FOREACH name IN ARRAY ARRAY['confirmed_memory','owner_memory','memory_candidate','source_document','message',
        'message_source_ref','local_wechat_observation','memory_extraction_trace_dependency','memory_extraction_trace_link'] LOOP
        EXECUTE format('CREATE TRIGGER organization_quality_dependencies AFTER UPDATE OR DELETE ON public.%I '
            'FOR EACH ROW EXECUTE FUNCTION public.erase_organization_quality_dependencies()', name);
    END LOOP;
END; $$;
CREATE TRIGGER organization_quality_correction AFTER INSERT OR UPDATE OR DELETE ON public.memory_correction_decision
    FOR EACH ROW EXECUTE FUNCTION public.erase_organization_quality_dependencies();
CREATE FUNCTION public.erase_organization_quality_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.settings_generation<>OLD.settings_generation OR NEW.correction_revision<>OLD.correction_revision
        OR NEW.organization_generation<>OLD.organization_generation THEN
        DELETE FROM public.organization_quality_case WHERE owner_id=NEW.owner_id AND contact_id IS NOT DISTINCT FROM NEW.contact_id;
    END IF;
    RETURN NEW;
END; $$;
CREATE TRIGGER organization_quality_scope AFTER UPDATE ON public.layered_memory_state
    FOR EACH ROW EXECUTE FUNCTION public.erase_organization_quality_scope();

CREATE TABLE public.organization_quality_run (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    stage text NOT NULL CHECK(stage IN ('organization','reply')),
    contract_id text NOT NULL,
    contract jsonb NOT NULL,
    dataset_version text NOT NULL,
    dataset_sha256 text NOT NULL,
    data_kind text NOT NULL CHECK(data_kind='fixed_synthetic'),
    case_count integer NOT NULL CHECK(case_count>0),
    max_http_attempts integer NOT NULL CHECK(max_http_attempts BETWEEN 1 AND 750),
    http_attempts_used integer NOT NULL DEFAULT 0 CHECK(http_attempts_used>=0 AND http_attempts_used<=max_http_attempts),
    state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','running','complete','failed')),
    transport_kind text,
    calibration jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    finished_at timestamptz
);
ALTER TABLE public.organization_quality_case ADD COLUMN run_id uuid REFERENCES public.organization_quality_run(id) ON DELETE CASCADE;
ALTER TABLE public.organization_quality_case ADD COLUMN output_review jsonb;
ALTER TABLE public.organization_quality_case ADD COLUMN execution_state text NOT NULL DEFAULT 'prepared';
ALTER TABLE public.organization_quality_case ADD COLUMN error_code text;
CREATE TABLE public.organization_quality_attempt (
    id uuid PRIMARY KEY,
    run_id uuid NOT NULL REFERENCES public.organization_quality_run(id) ON DELETE CASCADE,
    case_id uuid NOT NULL REFERENCES public.organization_quality_case(id) ON DELETE CASCADE,
    ordinal integer NOT NULL,
    phase text NOT NULL,
    request_payload jsonb NOT NULL,
    response_payload jsonb,
    outcome text NOT NULL DEFAULT 'unknown',
    request_model text NOT NULL,
    response_model text,
    system_fingerprint text,
    duration_ms integer,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(run_id,ordinal)
);
-- 任一参与输入被清理时整份报告及其输入/输出/请求/审阅副本一并清除。
CREATE FUNCTION public.erase_organization_quality_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM public.organization_quality_run WHERE id=OLD.run_id;
    RETURN OLD;
END; $$;
CREATE TRIGGER organization_quality_report AFTER DELETE ON public.organization_quality_case
    FOR EACH ROW EXECUTE FUNCTION public.erase_organization_quality_report();
ALTER TABLE public.organization_quality_run ADD COLUMN input_review_frozen boolean NOT NULL DEFAULT false;
ALTER TABLE public.organization_quality_run ADD COLUMN input_review_sha256 text;
ALTER TABLE public.organization_quality_case ADD COLUMN execution_token uuid;
ALTER TABLE public.organization_quality_case ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE public.organization_quality_attempt ADD COLUMN request_route text NOT NULL DEFAULT 'unknown';
CREATE TABLE public.organization_quality_revocation (
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    contract_id text NOT NULL,
    receipt text NOT NULL,
    reason text NOT NULL,
    PRIMARY KEY(owner_id,contract_id,receipt)
);

ALTER TABLE public.organization_quality_case ADD COLUMN guard_snapshot jsonb NOT NULL DEFAULT '{}';
CREATE TRIGGER organization_quality_feedback AFTER UPDATE OR DELETE ON public.layered_memory_feedback
    FOR EACH ROW EXECUTE FUNCTION public.erase_organization_quality_dependencies();

ALTER TABLE public.organization_quality_case ADD COLUMN stage_evidence jsonb NOT NULL DEFAULT '{}';

ALTER TABLE public.organization_quality_attempt ADD COLUMN measurements jsonb NOT NULL DEFAULT '{}';

CREATE TRIGGER organization_quality_fact_pending AFTER UPDATE OR DELETE ON public.layered_memory_fact_correction
    FOR EACH ROW EXECUTE FUNCTION public.erase_organization_quality_dependencies();

-- 只为显式单叶预备用途记录一次无正文过渡；普通业务不产生审计历史。
CREATE TABLE public.organization_quality_fact_intent (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    contact_id uuid,
    settings_generation bigint NOT NULL,
    origin_case_id uuid NOT NULL UNIQUE,
    origin_run_id uuid NOT NULL UNIQUE,
    old_memory_id uuid NOT NULL,
    old_revision bigint NOT NULL,
    request_digest text NOT NULL,
    dependency_ids uuid[] NOT NULL,
    state text NOT NULL CHECK(state IN ('pending','resolved','consumed')),
    expires_at timestamptz NOT NULL,
    decision_id uuid REFERENCES public.memory_correction_decision(id) ON DELETE CASCADE,
    replacement_memory_id uuid,
    replacement_revision bigint,
    consumer_case_id uuid REFERENCES public.organization_quality_case(id) ON DELETE CASCADE,
    FOREIGN KEY(owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE
);
CREATE INDEX organization_quality_fact_dependencies ON public.organization_quality_fact_intent USING gin(dependency_ids);
CREATE FUNCTION public.arm_organization_quality_fact_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE registered record;
BEGIN
    IF current_database() NOT LIKE '%\_test' ESCAPE '\' OR NEW.request_digest IS NULL THEN RETURN NEW; END IF;
    SELECT c.id,c.run_id,c.dependency_ids INTO registered FROM public.organization_quality_case c
    JOIN public.organization_quality_run r ON r.id=c.run_id
    WHERE c.owner_id=NEW.owner_id AND c.contact_id IS NOT DISTINCT FROM NEW.contact_id
      AND c.settings_generation=NEW.settings_generation AND c.execution_state='prepared'
      AND c.annotations IS NULL AND c.output_payload IS NULL AND c.input_manifest=jsonb_build_array(
          (SELECT item FROM jsonb_array_elements(c.input_manifest) item WHERE item->>'memory_id'=NEW.memory_id::text
              AND (item->>'revision')::bigint=NEW.memory_revision))
      AND r.dataset_version='fact-correction-path-preparation-v1' AND r.data_kind='fixed_synthetic'
      AND r.state='prepared' AND r.case_count=1 AND r.max_http_attempts=1 AND r.http_attempts_used=0
      AND r.created_at>clock_timestamp()-interval '30 minutes'
    ORDER BY r.created_at DESC LIMIT 1;
    IF registered.id IS NOT NULL THEN
        INSERT INTO public.organization_quality_fact_intent(id,owner_id,contact_id,settings_generation,
            origin_case_id,origin_run_id,old_memory_id,old_revision,request_digest,dependency_ids,state,expires_at)
        VALUES(NEW.id,NEW.owner_id,NEW.contact_id,NEW.settings_generation,registered.id,registered.run_id,
            NEW.memory_id,NEW.memory_revision,NEW.request_digest,
            ARRAY(SELECT DISTINCT value FROM unnest(registered.dependency_ids||ARRAY[NEW.id]||NEW.dependency_ids||NEW.protected_message_ids
                ||ARRAY(SELECT jsonb_array_elements_text(COALESCE(to_jsonb(NEW)->'observation_ids','[]'))::uuid)
                ||ARRAY(SELECT jsonb_array_elements_text(COALESCE(to_jsonb(NEW)->'source_ref_ids','[]'))::uuid)) value ORDER BY value),
            'pending',clock_timestamp()+interval '30 minutes') ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END; $$;
CREATE TRIGGER organization_quality_fact_registration BEFORE INSERT ON public.layered_memory_fact_correction
    FOR EACH ROW EXECUTE FUNCTION public.arm_organization_quality_fact_intent();

-- 更正会先撤旧叶、清pending，最后写真实decision；只在同一事务完成后核验，不补签已删除用途。
CREATE FUNCTION public.resolve_organization_quality_fact_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent record; decision record;
BEGIN
    SELECT * INTO intent FROM public.organization_quality_fact_intent WHERE id=OLD.id AND state='pending' FOR UPDATE;
    IF intent.id IS NULL THEN RETURN OLD; END IF;
    SELECT d.id,m.id AS memory_id,m.revision INTO decision FROM public.memory_correction_decision d
    JOIN (SELECT id,owner_id,contact_id,supersedes_memory_id,revision,status FROM public.confirmed_memory
        UNION ALL SELECT id,owner_id,NULL::uuid,supersedes_memory_id,revision,status FROM public.owner_memory) m
      ON m.id=d.replacement_memory_id AND m.owner_id=d.owner_id AND m.contact_id IS NOT DISTINCT FROM d.contact_id
    JOIN public.layered_memory_state s ON s.owner_id=d.owner_id AND s.contact_id IS NOT DISTINCT FROM d.contact_id
    WHERE d.owner_id=intent.owner_id AND d.contact_id IS NOT DISTINCT FROM intent.contact_id
      AND d.record_id=intent.old_memory_id AND d.decision='corrected'
      AND d.xmin=pg_current_xact_id()::text::xid AND m.status='active'
      AND m.supersedes_memory_id=intent.old_memory_id AND m.revision=intent.old_revision+1
      AND s.settings_generation=intent.settings_generation AND intent.expires_at>clock_timestamp();
    IF decision.id IS NULL THEN
        DELETE FROM public.organization_quality_fact_intent WHERE id=intent.id;
    ELSE
        UPDATE public.organization_quality_fact_intent SET state='resolved',decision_id=decision.id,
            replacement_memory_id=decision.memory_id,replacement_revision=decision.revision,
            dependency_ids=dependency_ids||ARRAY[decision.id,decision.memory_id] WHERE id=intent.id AND state='pending';
    END IF;
    RETURN OLD;
END; $$;
CREATE CONSTRAINT TRIGGER organization_quality_fact_resolution AFTER DELETE ON public.layered_memory_fact_correction
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.resolve_organization_quality_fact_intent();

CREATE FUNCTION public.erase_organization_quality_fact_intents() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE identifiers uuid[]; row_data jsonb;
BEGIN
    IF TG_OP='UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
    row_data:=to_jsonb(OLD);
    IF TG_TABLE_NAME='layered_memory_state' THEN
        IF NEW.settings_generation<>OLD.settings_generation THEN
            DELETE FROM public.organization_quality_fact_intent WHERE owner_id=NEW.owner_id
                AND contact_id IS NOT DISTINCT FROM NEW.contact_id;
        END IF;
    ELSIF TG_TABLE_NAME='organization_quality_case' THEN
        DELETE FROM public.organization_quality_fact_intent i WHERE i.origin_case_id=OLD.id
            AND NOT (i.state='pending' AND EXISTS(SELECT 1 FROM public.layered_memory_fact_correction p WHERE p.id=i.id));
    ELSE
        SELECT array_agg(value::uuid) INTO identifiers FROM (
            SELECT row_data->>key AS value FROM unnest(ARRAY['id','message_id','source_document_id','observation_id',
                'source_candidate_id','record_id','replacement_memory_id','source_id','trace_id']) key
            UNION SELECT jsonb_array_elements_text(COALESCE(row_data->'source_ids','[]'))
        ) ids WHERE value IS NOT NULL;
        IF TG_OP='INSERT' THEN identifiers:=ARRAY[NEW.record_id,NEW.replacement_memory_id]; END IF;
        DELETE FROM public.organization_quality_fact_intent i WHERE i.owner_id=COALESCE(
            (row_data->>'owner_id')::uuid,(to_jsonb(NEW)->>'owner_id')::uuid) AND i.dependency_ids && identifiers
            AND NOT (i.state='pending' AND (
                TG_TABLE_NAME IN ('confirmed_memory','owner_memory') AND TG_OP='UPDATE'
                    AND i.old_memory_id=(row_data->>'id')::uuid AND to_jsonb(NEW)->>'status'='invalidated'
                OR TG_TABLE_NAME='memory_correction_decision' AND TG_OP='INSERT'
                    AND (to_jsonb(NEW)->>'record_id')::uuid=i.old_memory_id AND to_jsonb(NEW)->>'decision'='corrected'
                OR TG_TABLE_NAME='layered_memory_fact_correction' AND TG_OP='DELETE'));
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END; $$;
DO $$ DECLARE name text; BEGIN
    FOREACH name IN ARRAY ARRAY['confirmed_memory','owner_memory','memory_candidate','source_document','message',
        'message_source_ref','local_wechat_observation','memory_extraction_trace_dependency','memory_extraction_trace_link',
        'layered_memory_fact_correction','layered_memory_state'] LOOP
        EXECUTE format('CREATE TRIGGER organization_quality_fact_erasure AFTER UPDATE OR DELETE ON public.%I '
            'FOR EACH ROW EXECUTE FUNCTION public.erase_organization_quality_fact_intents()',name);
    END LOOP;
END; $$;
CREATE TRIGGER organization_quality_fact_decision AFTER INSERT OR UPDATE OR DELETE ON public.memory_correction_decision
    FOR EACH ROW EXECUTE FUNCTION public.erase_organization_quality_fact_intents();
CREATE TRIGGER organization_quality_fact_purpose AFTER DELETE ON public.organization_quality_case
    FOR EACH ROW EXECUTE FUNCTION public.erase_organization_quality_fact_intents();
CREATE FUNCTION public.erase_organization_quality_fact_consumer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM public.organization_quality_case WHERE id=OLD.consumer_case_id;
    RETURN OLD;
END; $$;
CREATE TRIGGER organization_quality_fact_consumer AFTER DELETE ON public.organization_quality_fact_intent
    FOR EACH ROW EXECUTE FUNCTION public.erase_organization_quality_fact_consumer();
