-- 整理反馈独立于正确事实；无正文保护只在旧合法依据仍存在时保留。
ALTER TABLE public.layered_memory_state ADD COLUMN correction_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE public.layered_memory_batch ADD COLUMN correction_input jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(correction_input)='array');
ALTER TABLE public.layered_profile_batch ADD COLUMN correction_input jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(correction_input)='array');
CREATE TABLE public.layered_memory_feedback (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    contact_id uuid,
    scope_kind text GENERATED ALWAYS AS (CASE WHEN contact_id IS NULL THEN 'owner' ELSE 'contact' END) STORED NOT NULL,
    scope_key uuid GENERATED ALWAYS AS (COALESCE(contact_id,owner_id)) STORED NOT NULL,
    operation_id uuid NOT NULL,
    request_digest text,
    settings_generation bigint NOT NULL,
    target_kind text NOT NULL CHECK(target_kind IN ('scenario','profile')),
    version_id uuid,
    item_index integer NOT NULL CHECK(item_index>=0),
    reason text CHECK(length(reason)<=500),
    rejected_text text,
    input_manifest jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(input_manifest)='array'),
    dependency_ids uuid[] NOT NULL,
    protected_memory_ids uuid[] NOT NULL,
    protected_message_ids uuid[] NOT NULL,
    state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','erased_guard')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(owner_id,scope_kind,scope_key,operation_id),
    FOREIGN KEY(owner_id,scope_kind,scope_key) REFERENCES public.layered_memory_state(owner_id,scope_kind,scope_key) ON DELETE CASCADE,
    FOREIGN KEY(contact_id,owner_id) REFERENCES public.contact(id,owner_id) ON DELETE CASCADE,
    CHECK(state='active' OR (reason IS NULL AND rejected_text IS NULL AND input_manifest='[]' AND cardinality(dependency_ids)=0))
);

-- 事实报错只等待精确叶版本的合法修正；不保存正文，也不沿新版本链形成长期偏好。
CREATE TABLE public.layered_memory_fact_correction (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    contact_id uuid,
    scope_kind text GENERATED ALWAYS AS (CASE WHEN contact_id IS NULL THEN 'owner' ELSE 'contact' END) STORED NOT NULL,
    scope_key uuid GENERATED ALWAYS AS (COALESCE(contact_id,owner_id)) STORED NOT NULL,
    settings_generation bigint NOT NULL,
    request_digest text,
    memory_id uuid NOT NULL,
    memory_revision bigint NOT NULL CHECK(memory_revision>0),
    source_dependency_mode text NOT NULL CHECK(source_dependency_mode IN ('any','all')),
    dependency_ids uuid[] NOT NULL,
    protected_message_ids uuid[] NOT NULL,
    observation_ids uuid[] NOT NULL DEFAULT '{}',
    source_ref_ids uuid[] NOT NULL DEFAULT '{}',
    UNIQUE(owner_id,scope_kind,scope_key,settings_generation,request_digest),
    FOREIGN KEY(owner_id,scope_kind,scope_key) REFERENCES public.layered_memory_state(owner_id,scope_kind,scope_key) ON DELETE CASCADE,
    FOREIGN KEY(contact_id,owner_id) REFERENCES public.contact(id,owner_id) ON DELETE CASCADE,
    CHECK(request_digest IS NOT NULL OR cardinality(dependency_ids)+cardinality(observation_ids)+cardinality(source_ref_ids)=0)
);

-- 只核对原参与集合的类型及绑定；共享manual source或其他行的更新不等于来源失效。
CREATE FUNCTION public.layered_fact_receipt_sources_live(receipt public.layered_memory_fact_correction)
RETURNS boolean LANGUAGE sql AS $$
    SELECT NOT EXISTS(SELECT 1 FROM public.source_document d WHERE d.owner_id=receipt.owner_id
        AND d.id=ANY(receipt.dependency_ids) AND d.status<>'active')
    AND NOT EXISTS(SELECT 1 FROM unnest(receipt.observation_ids) original(id) WHERE NOT EXISTS(
        SELECT 1 FROM public.local_wechat_observation o WHERE o.id=original.id AND o.owner_id=receipt.owner_id
        AND (receipt.contact_id IS NULL OR o.contact_id=receipt.contact_id)))
    AND NOT EXISTS(SELECT 1 FROM unnest(receipt.source_ref_ids) original(id) WHERE NOT EXISTS(
        SELECT 1 FROM public.message_source_ref r WHERE r.id=original.id AND r.owner_id=receipt.owner_id
        AND (receipt.contact_id IS NULL OR r.contact_id=receipt.contact_id)
        AND r.message_id=ANY(receipt.dependency_ids)
        AND COALESCE(r.source_document_id,r.observation_id)=ANY(receipt.dependency_ids)));
$$;

-- 手录的共享source不构成错误身份；只保留仍有合法活动叶的原手录根。
CREATE FUNCTION public.live_layered_manual_guard_ids(affected_owner uuid, affected_contact uuid, identifiers uuid[])
RETURNS uuid[] LANGUAGE sql STABLE AS $$
    WITH RECURSIVE records AS (
        SELECT id,supersedes_memory_id,status,source_ids FROM public.confirmed_memory
        WHERE owner_id=affected_owner AND contact_id=affected_contact
        UNION ALL SELECT id,supersedes_memory_id,status,source_ids FROM public.owner_memory
        WHERE owner_id=affected_owner AND affected_contact IS NULL
    ), chain AS (
        SELECT r.id,r.id AS root FROM records r WHERE r.id=ANY(identifiers)
          AND (r.source_ids=ARRAY[affected_owner] OR EXISTS(SELECT 1 FROM public.source_document d
              WHERE d.id=ANY(r.source_ids) AND d.owner_id=affected_owner AND d.source_type='manual' AND d.status='active'))
        UNION SELECT r.id,c.root FROM records r JOIN chain c ON r.supersedes_memory_id=c.id
    ) SELECT ARRAY(SELECT DISTINCT c.root FROM chain c JOIN records r ON r.id=c.id WHERE r.status='active');
$$;

CREATE FUNCTION public.bump_layered_correction_revision(affected_owner uuid, affected_contact uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO public.layered_memory_generation(owner_id,contact_id,organization_generation,schema_version,
        scenario_version_ids,profile_version_id,dependency_ids)
    SELECT g.owner_id,g.contact_id,g.organization_generation+1,g.schema_version,g.scenario_version_ids,g.profile_version_id,g.dependency_ids
    FROM public.layered_memory_generation g JOIN public.layered_memory_state s
      ON s.owner_id=g.owner_id AND s.contact_id IS NOT DISTINCT FROM g.contact_id AND s.organization_generation=g.organization_generation
    WHERE s.owner_id=affected_owner AND s.contact_id IS NOT DISTINCT FROM affected_contact;
    UPDATE public.layered_memory_state SET correction_revision=correction_revision+1,
        organization_generation=organization_generation+1,dirty_revision=dirty_revision+1,
        next_due_at=COALESCE(next_due_at,clock_timestamp()+interval '350 milliseconds')
    WHERE owner_id=affected_owner AND contact_id IS NOT DISTINCT FROM affected_contact;
END; $$;

-- 从产生时接入原事务；每轮重算所有旧guard，不能依赖已擦空的敏感依赖数组。
ALTER FUNCTION public.erase_layered_memory_dependencies(uuid,uuid[]) RENAME TO erase_layered_memory_dependencies_v77;
CREATE FUNCTION public.erase_layered_memory_dependencies(affected_owner uuid, identifiers uuid[])
RETURNS void LANGUAGE plpgsql AS $$
DECLARE feedback record; receipt public.layered_memory_fact_correction%ROWTYPE;
    messages uuid[]; memories uuid[]; erase_body boolean; live_leaf boolean;
BEGIN
    -- 删除排队即清原请求身份；仍合法的同一规范消息只保留无正文待修正约束。
    FOR receipt IN SELECT * FROM public.layered_memory_fact_correction WHERE owner_id=affected_owner LOOP
        SELECT ARRAY(SELECT DISTINCT r.message_id FROM public.message_source_ref r WHERE r.owner_id=affected_owner
          AND r.message_id=ANY(receipt.protected_message_ids) AND (
            EXISTS(SELECT 1 FROM public.source_document d WHERE d.id=r.source_document_id AND d.status='active') OR
            EXISTS(SELECT 1 FROM public.local_wechat_observation o WHERE o.id=r.observation_id))
            ORDER BY r.message_id) INTO messages;
        SELECT EXISTS(SELECT 1 FROM public.confirmed_memory m WHERE m.owner_id=affected_owner
            AND m.contact_id=receipt.contact_id AND m.id=receipt.memory_id
            AND m.revision=receipt.memory_revision AND m.status='active'
            UNION ALL SELECT 1 FROM public.owner_memory m WHERE m.owner_id=affected_owner
            AND receipt.contact_id IS NULL AND m.id=receipt.memory_id
            AND m.revision=receipt.memory_revision AND m.status='active') INTO live_leaf;
        live_leaf:=live_leaf AND CASE WHEN cardinality(receipt.protected_message_ids)>0 THEN
            cardinality(messages)>0 AND (receipt.source_dependency_mode='any' OR cardinality(messages)=cardinality(receipt.protected_message_ids))
            ELSE receipt.memory_id=ANY(public.live_layered_manual_guard_ids(
                affected_owner,receipt.contact_id,ARRAY[receipt.memory_id])) END;
        IF NOT live_leaf THEN
            DELETE FROM public.layered_memory_fact_correction WHERE id=receipt.id;
            PERFORM public.bump_layered_correction_revision(affected_owner,receipt.contact_id);
        ELSIF receipt.request_digest IS NOT NULL AND NOT public.layered_fact_receipt_sources_live(receipt)
            OR messages IS DISTINCT FROM receipt.protected_message_ids THEN
            UPDATE public.layered_memory_fact_correction SET request_digest=NULL,dependency_ids='{}',
                observation_ids='{}',source_ref_ids='{}',protected_message_ids=messages
            WHERE id=receipt.id;
            PERFORM public.bump_layered_correction_revision(affected_owner,receipt.contact_id);
        END IF;
    END LOOP;
    FOR feedback IN SELECT * FROM public.layered_memory_feedback WHERE owner_id=affected_owner
        AND (state='erased_guard' OR dependency_ids && identifiers) LOOP
        erase_body:=feedback.state='active';
        SELECT ARRAY(SELECT DISTINCT r.message_id FROM public.message_source_ref r WHERE r.owner_id=affected_owner
          AND r.message_id=ANY(feedback.protected_message_ids) AND (
            EXISTS(SELECT 1 FROM public.source_document d WHERE d.id=r.source_document_id AND d.status='active') OR
            EXISTS(SELECT 1 FROM public.local_wechat_observation o WHERE o.id=r.observation_id))) INTO messages;
        memories:=public.live_layered_manual_guard_ids(affected_owner,feedback.contact_id,feedback.protected_memory_ids);
        IF erase_body OR messages IS DISTINCT FROM feedback.protected_message_ids OR memories IS DISTINCT FROM feedback.protected_memory_ids THEN
            PERFORM public.bump_layered_correction_revision(affected_owner,feedback.contact_id);
            IF cardinality(messages)+cardinality(memories)=0 THEN
                DELETE FROM public.layered_memory_feedback WHERE id=feedback.id;
            ELSE
                UPDATE public.layered_memory_feedback SET reason=NULL,rejected_text=NULL,request_digest=NULL,version_id=NULL,
                    input_manifest='[]',dependency_ids='{}',state='erased_guard',protected_memory_ids=memories,protected_message_ids=messages
                WHERE id=feedback.id;
            END IF;
        END IF;
    END LOOP;
    PERFORM public.erase_layered_memory_dependencies_v77(affected_owner,identifiers);
END; $$;
