-- 退役原因仅表达用户明确决定；存量和自动失效保持 unknown，禁止猜测过去事实。
ALTER TABLE public.confirmed_memory
    ADD COLUMN retirement_reason text NOT NULL DEFAULT 'unknown'
        CHECK (retirement_reason IN ('unknown', 'error_correction', 'state_changed')),
    ADD COLUMN retired_at timestamptz;
ALTER TABLE public.owner_memory
    ADD COLUMN retirement_reason text NOT NULL DEFAULT 'unknown'
        CHECK (retirement_reason IN ('unknown', 'error_correction', 'state_changed')),
    ADD COLUMN retired_at timestamptz;
-- retired_at 是修改记录时间，不能替代事实有效期 invalid_at。
COMMENT ON COLUMN public.confirmed_memory.retired_at IS '用户或系统记录旧版退出当前资料的时间，不是事实发生变化的时间';
COMMENT ON COLUMN public.owner_memory.retired_at IS '用户或系统记录旧版退出当前资料的时间，不是事实发生变化的时间';

CREATE OR REPLACE FUNCTION public.invalidate_layered_memory_dependencies()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    row_data jsonb;
    old_data jsonb;
    new_data jsonb;
    identifiers uuid[];
    affected_owner uuid;
BEGIN
    IF TG_OP='UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
    -- 退出当前资料不等于删除：旧派生正文留作审计，生成按底层清单逐次复验。
    -- 仅允许身份、正文、来源不变的退役；源资料撤销和物理删除仍走原清理闭包。
    IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('confirmed_memory','owner_memory')
       AND to_jsonb(NEW)->>'status'='invalidated'
       AND (to_jsonb(OLD)-ARRAY['status','retirement_reason','retired_at','revision','updated_at','invalid_at'])
           = (to_jsonb(NEW)-ARRAY['status','retirement_reason','retired_at','revision','updated_at','invalid_at']) THEN
        RETURN NEW;
    END IF;
    IF TG_OP='INSERT' AND TG_TABLE_NAME='memory_correction_decision'
       AND to_jsonb(NEW)->>'decision'='corrected' THEN RETURN NEW; END IF;
    IF TG_OP<>'INSERT' THEN old_data:=to_jsonb(OLD); END IF;
    IF TG_OP<>'DELETE' THEN new_data:=to_jsonb(NEW); END IF;
    FOR row_data IN SELECT value FROM jsonb_array_elements(jsonb_build_array(old_data,new_data))
        WHERE value<>'null'::jsonb LOOP
        affected_owner:=(row_data->>'owner_id')::uuid;
        PERFORM pg_advisory_xact_lock(hashtextextended('owner:'||affected_owner::text,0));
        SELECT array_agg(value::uuid) INTO identifiers FROM (
            SELECT row_data->>key AS value FROM unnest(ARRAY[
                'id','message_id','source_document_id','observation_id','source_candidate_id',
                'record_id','replacement_memory_id','source_id','trace_id']) AS key
            UNION SELECT jsonb_array_elements_text(COALESCE(row_data->'source_ids','[]'::jsonb))
        ) AS ids WHERE value IS NOT NULL;
        PERFORM public.erase_layered_memory_dependencies(affected_owner,identifiers);
    END LOOP;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;
