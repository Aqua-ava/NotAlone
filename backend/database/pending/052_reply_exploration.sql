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
    request_key uuid NOT NULL DEFAULT gen_random_uuid(),
    input_payload jsonb,
    result_payload jsonb,
    source_ids uuid[] NOT NULL DEFAULT '{}',
    skill_library_revision bigint NOT NULL CHECK (skill_library_revision >= 0),
    skill_version_id uuid,
    state text NOT NULL CHECK (state IN ('running', 'ready', 'selected', 'confirmed', 'paused', 'failed', 'stale', 'redacted')),
    selected_intent text,
    automatic_call_count integer NOT NULL DEFAULT 0 CHECK (automatic_call_count BETWEEN 0 AND 3),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (session_id, owner_id, contact_id)
        REFERENCES public.assistant_session(id, owner_id, contact_id) ON DELETE CASCADE,
    UNIQUE (id, owner_id, contact_id),
    CHECK (state <> 'redacted' OR (input_payload IS NULL AND result_payload IS NULL AND selected_intent IS NULL AND cardinality(source_ids) = 0))
);
CREATE INDEX reply_exploration_scope_idx ON public.reply_exploration (owner_id, contact_id, session_id, created_at);
CREATE INDEX reply_exploration_sources_idx ON public.reply_exploration USING gin (source_ids);

-- 删除请求立即清除派生正文，不能等到模型或桌面收到迟到结果后才清理。
CREATE FUNCTION public.redact_reply_exploration_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status <> 'active' THEN
        UPDATE public.reply_exploration
        SET state = 'redacted', input_payload = NULL, result_payload = NULL,
            selected_intent = NULL, source_ids = '{}', updated_at = now()
        WHERE owner_id = NEW.owner_id AND NEW.id = ANY(source_ids);
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER reply_exploration_source_redaction AFTER UPDATE OF status ON public.source_document
    FOR EACH ROW EXECUTE FUNCTION public.redact_reply_exploration_source();

CREATE FUNCTION public.redact_reply_exploration_removed_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE public.reply_exploration
    SET state = 'redacted', input_payload = NULL, result_payload = NULL,
        selected_intent = NULL, source_ids = '{}', updated_at = now()
    WHERE owner_id = OLD.owner_id AND OLD.id = ANY(source_ids);
    RETURN OLD;
END;
$$;
CREATE TRIGGER reply_exploration_source_removed BEFORE DELETE ON public.source_document
    FOR EACH ROW EXECUTE FUNCTION public.redact_reply_exploration_removed_source();
CREATE TRIGGER reply_exploration_observation_removed BEFORE DELETE ON public.local_wechat_observation
    FOR EACH ROW EXECUTE FUNCTION public.redact_reply_exploration_removed_source();

-- 不保存Skill正文；目录改变后连派生建议也不可恢复。
CREATE FUNCTION public.invalidate_reply_exploration_skill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE public.reply_exploration SET state = 'stale', result_payload = NULL,
        selected_intent = NULL, updated_at = now()
    WHERE owner_id = NEW.owner_id AND skill_library_revision <> NEW.revision AND state <> 'redacted';
    RETURN NEW;
END;
$$;
CREATE TRIGGER reply_exploration_skill_revision AFTER UPDATE OF revision ON public.skill_library
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_reply_exploration_skill();

COMMENT ON TABLE public.reply_exploration IS
    '未确认意愿的模型建议；输入版本权威为assistant_session，不能自动成为候选、用户决定或长期记忆。';

COMMIT;
