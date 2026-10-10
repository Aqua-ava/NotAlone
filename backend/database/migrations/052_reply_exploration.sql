BEGIN;

-- 方案与组内消息分层保存；存量单句使用候选ID作为首条消息的稳定身份。
ALTER TABLE public.reply_candidate ADD COLUMN message_group jsonb;
UPDATE public.reply_candidate SET message_group = jsonb_build_array(
    jsonb_build_object('message_id', id::text, 'text', candidate_text)
);

CREATE FUNCTION public.valid_candidate_message_group(group_value jsonb, aggregate_text text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; seen uuid[] := '{}'; message_key uuid; parts text[] := '{}';
BEGIN
    IF jsonb_typeof(group_value) <> 'array' OR jsonb_array_length(group_value) NOT BETWEEN 1 AND 8
       OR length(aggregate_text) > 65536 THEN RETURN false; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(group_value) LOOP
        IF jsonb_typeof(item) <> 'object' OR NOT item ?& ARRAY['message_id','text']
           OR item - ARRAY['message_id','text'] <> '{}'::jsonb
           OR jsonb_typeof(item->'message_id') <> 'string' OR jsonb_typeof(item->'text') <> 'string'
           OR length(btrim(item->>'text')) = 0
           OR length(item->>'text') > (CASE WHEN jsonb_array_length(group_value)=1 THEN 65536 ELSE 8192 END)
        THEN RETURN false; END IF;
        message_key := (item->>'message_id')::uuid;
        IF message_key = ANY(seen) THEN RETURN false; END IF;
        seen := array_append(seen, message_key);
        parts := array_append(parts, item->>'text');
    END LOOP;
    RETURN array_to_string(parts, E'\n\n') = aggregate_text;
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END;
$$;
CREATE FUNCTION public.populate_candidate_message_group() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.message_group IS NULL THEN
        NEW.message_group := jsonb_build_array(jsonb_build_object('message_id', NEW.id::text, 'text', NEW.candidate_text));
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER reply_candidate_single_message BEFORE INSERT ON public.reply_candidate
    FOR EACH ROW EXECUTE FUNCTION public.populate_candidate_message_group();
ALTER TABLE public.reply_candidate ALTER COLUMN message_group SET NOT NULL;
ALTER TABLE public.reply_candidate ADD CONSTRAINT reply_candidate_message_group_valid
    CHECK (public.valid_candidate_message_group(message_group, candidate_text));

CREATE TABLE public.reply_exploration (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    session_id uuid NOT NULL,
    input_version_id uuid NOT NULL,
    operation_key uuid NOT NULL,
    operation_digest text NOT NULL CHECK (operation_digest ~ '^[0-9a-f]{64}$'),
    request_key uuid NOT NULL DEFAULT gen_random_uuid(),
    input_payload jsonb CHECK (input_payload IS NULL OR jsonb_typeof(input_payload)='object'),
    result_payload jsonb CHECK (result_payload IS NULL OR jsonb_typeof(result_payload)='object'),
    snapshots jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(snapshots)='array' AND jsonb_array_length(snapshots)<=7),
    intent_snapshots jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(intent_snapshots)='array' AND jsonb_array_length(intent_snapshots)<=7),
    source_ids uuid[] NOT NULL DEFAULT '{}',
    skill_library_revision bigint NOT NULL CHECK (skill_library_revision >= 0),
    skill_version_id uuid,
    state text NOT NULL CHECK (state IN ('running','ready','selected','confirmed','paused','failed','stale','redacted','expired')),
    selected_intent text CHECK (selected_intent IS NULL OR length(btrim(selected_intent)) BETWEEN 1 AND 4096),
    selection_id uuid,
    selection_source text CHECK (selection_source IN ('direct_input','confirmed_suggestion')),
    root_created_at timestamptz NOT NULL DEFAULT now(),
    automatic_call_count integer NOT NULL DEFAULT 0 CHECK (automatic_call_count BETWEEN 0 AND 3),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (session_id,owner_id,contact_id)
        REFERENCES public.assistant_session(id,owner_id,contact_id) ON DELETE CASCADE,
    FOREIGN KEY (input_version_id,session_id,owner_id,contact_id)
        REFERENCES public.assistant_session_input(id,session_id,owner_id,contact_id) ON DELETE CASCADE,
    UNIQUE (owner_id,contact_id,session_id,operation_key),
    UNIQUE (owner_id,contact_id,request_key),
    CHECK ((selected_intent IS NULL AND selection_id IS NULL AND selection_source IS NULL)
        OR (selected_intent IS NOT NULL AND selection_id IS NOT NULL AND selection_source IS NOT NULL)),
    CHECK (state NOT IN ('redacted','expired') OR (input_payload IS NULL AND result_payload IS NULL
        AND selected_intent IS NULL AND selection_id IS NULL AND selection_source IS NULL
        AND snapshots='[]' AND intent_snapshots='[]' AND cardinality(source_ids)=0))
);
CREATE INDEX reply_exploration_scope_idx ON public.reply_exploration (owner_id,contact_id,session_id,created_at);
CREATE INDEX reply_exploration_expiry_idx ON public.reply_exploration (owner_id,contact_id,root_created_at);
CREATE INDEX reply_exploration_sources_idx ON public.reply_exploration USING gin (source_ids);

-- 同一删除事务内擦除全部派生副本；UUID/摘要只保留失效操作占位。
CREATE FUNCTION public.erase_reply_exploration_source(source_owner uuid,removed_id uuid)
RETURNS void LANGUAGE sql AS $$
    UPDATE public.reply_exploration SET state='redacted',input_payload=NULL,result_payload=NULL,
        snapshots='[]',intent_snapshots='[]',selected_intent=NULL,selection_id=NULL,
        selection_source=NULL,source_ids='{}',updated_at=now()
    WHERE owner_id=source_owner AND removed_id=ANY(source_ids);
$$;
CREATE FUNCTION public.redact_reply_exploration_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status<>'active' THEN
        PERFORM public.erase_reply_exploration_source(NEW.owner_id,NEW.id);
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER reply_exploration_source_redaction AFTER UPDATE OF status ON public.source_document
    FOR EACH ROW EXECUTE FUNCTION public.redact_reply_exploration_source();
CREATE FUNCTION public.redact_reply_exploration_removed_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM public.erase_reply_exploration_source(OLD.owner_id,OLD.id);
    RETURN OLD;
END;
$$;
CREATE TRIGGER reply_exploration_source_removed BEFORE DELETE ON public.source_document
    FOR EACH ROW EXECUTE FUNCTION public.redact_reply_exploration_removed_source();
CREATE TRIGGER reply_exploration_observation_removed BEFORE DELETE ON public.local_wechat_observation
    FOR EACH ROW EXECUTE FUNCTION public.redact_reply_exploration_removed_source();
CREATE TRIGGER reply_exploration_message_removed BEFORE DELETE ON public.message
    FOR EACH ROW EXECUTE FUNCTION public.redact_reply_exploration_removed_source();
CREATE TRIGGER reply_exploration_memory_removed BEFORE DELETE ON public.confirmed_memory
    FOR EACH ROW EXECUTE FUNCTION public.redact_reply_exploration_removed_source();
CREATE TRIGGER reply_exploration_memory_changed AFTER UPDATE OF text_content,status,revision,valid_at,invalid_at,source_ids
    ON public.confirmed_memory FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW)
    EXECUTE FUNCTION public.redact_reply_exploration_removed_source();
CREATE TRIGGER reply_exploration_message_changed AFTER UPDATE OF text_content,speaker,occurred_at
    ON public.message FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW)
    EXECUTE FUNCTION public.redact_reply_exploration_removed_source();
CREATE FUNCTION public.redact_reply_exploration_message_ref() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM public.erase_reply_exploration_source(OLD.owner_id,OLD.message_id);
    RETURN OLD;
END;
$$;
CREATE TRIGGER reply_exploration_message_ref_removed BEFORE DELETE ON public.message_source_ref
    FOR EACH ROW EXECUTE FUNCTION public.redact_reply_exploration_message_ref();

-- A的讨论正文擦除是权威；B不另造一次来源/生命周期判断。
CREATE FUNCTION public.redact_reply_exploration_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.state='redacted' THEN
        UPDATE public.reply_exploration SET state='redacted',input_payload=NULL,result_payload=NULL,
            snapshots='[]',intent_snapshots='[]',selected_intent=NULL,selection_id=NULL,
            selection_source=NULL,source_ids='{}',updated_at=now()
        WHERE owner_id=NEW.owner_id AND contact_id=NEW.contact_id AND input_version_id=NEW.id;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER reply_exploration_input_redaction AFTER UPDATE OF state ON public.assistant_session_input
    FOR EACH ROW EXECUTE FUNCTION public.redact_reply_exploration_input();

-- 丢弃失效Skill的模型理解/选项，但保留用户已确认意愿，供明确刷新后延续。
CREATE FUNCTION public.invalidate_reply_exploration_skill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE public.reply_exploration SET state=CASE WHEN state='paused' THEN 'paused' ELSE 'stale' END,
        result_payload=NULL,updated_at=now()
    WHERE owner_id=NEW.owner_id AND skill_library_revision<>NEW.revision
        AND state NOT IN ('redacted','expired');
    RETURN NEW;
END;
$$;
CREATE TRIGGER reply_exploration_skill_revision AFTER UPDATE OF revision ON public.skill_library
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_reply_exploration_skill();
COMMENT ON TABLE public.reply_exploration IS
    'A输入UUID的有界探索派生记录；仅用户选择建立意愿，不自动生成或写长期资料。';
COMMENT ON COLUMN public.reply_exploration.root_created_at IS
    '原用户任务15分钟上限；纠正、换组与增量更新不延长。';
COMMIT;
