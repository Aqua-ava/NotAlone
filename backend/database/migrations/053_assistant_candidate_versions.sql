BEGIN;

-- 正式001–052前缀上的候选版本升级稿；扫描目录消费及公开接线仍由总协调完成。
ALTER TABLE public.reply_candidate
    ADD CONSTRAINT reply_candidate_version_scope_unique UNIQUE (id, owner_id, contact_id);
ALTER TABLE public.assistant_session_turn
    ADD CONSTRAINT assistant_turn_candidate_scope_unique
    UNIQUE (id, session_id, owner_id, contact_id);

CREATE TABLE public.assistant_candidate_version (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    version_number integer NOT NULL CHECK (version_number >= 0),
    parent_version_id uuid,
    edit_key uuid,
    message_group jsonb,
    requirements text CHECK (requirements IS NULL OR length(btrim(requirements)) BETWEEN 1 AND 4096),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (session_id, owner_id, contact_id)
        REFERENCES public.assistant_session(id, owner_id, contact_id) ON DELETE CASCADE,
    FOREIGN KEY (turn_id, session_id, owner_id, contact_id)
        REFERENCES public.assistant_session_turn(id, session_id, owner_id, contact_id) ON DELETE CASCADE,
    FOREIGN KEY (candidate_id, owner_id, contact_id)
        REFERENCES public.reply_candidate(id, owner_id, contact_id) ON DELETE CASCADE,
    UNIQUE (candidate_id, version_number),
    UNIQUE (session_id, owner_id, contact_id, candidate_id, edit_key),
    UNIQUE (id, candidate_id, session_id, owner_id, contact_id),
    FOREIGN KEY (parent_version_id, candidate_id, session_id, owner_id, contact_id)
        REFERENCES public.assistant_candidate_version(id, candidate_id, session_id, owner_id, contact_id)
        ON DELETE CASCADE,
    CHECK (
        (version_number = 0 AND id = candidate_id AND parent_version_id IS NULL
            AND edit_key IS NULL AND message_group IS NULL AND requirements IS NULL)
        OR (version_number > 0 AND parent_version_id IS NOT NULL AND edit_key IS NOT NULL
            AND message_group IS NOT NULL AND jsonb_typeof(message_group) = 'array')
    )
);

CREATE TABLE public.assistant_candidate_selection (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    session_id uuid NOT NULL,
    selection_key uuid NOT NULL,
    selection_number integer NOT NULL CHECK (selection_number > 0),
    candidate_id uuid NOT NULL,
    version_id uuid NOT NULL,
    is_current boolean NOT NULL DEFAULT TRUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (session_id, owner_id, contact_id, selection_key),
    UNIQUE (session_id, owner_id, contact_id, selection_number),
    FOREIGN KEY (session_id, owner_id, contact_id)
        REFERENCES public.assistant_session(id, owner_id, contact_id) ON DELETE CASCADE,
    FOREIGN KEY (version_id, candidate_id, session_id, owner_id, contact_id)
        REFERENCES public.assistant_candidate_version(id, candidate_id, session_id, owner_id, contact_id)
        ON DELETE CASCADE
);

CREATE INDEX assistant_candidate_version_order_idx
    ON public.assistant_candidate_version(owner_id, contact_id, session_id, candidate_id, version_number);
CREATE INDEX assistant_candidate_selection_order_idx
    ON public.assistant_candidate_selection(owner_id, contact_id, session_id, selection_number DESC);
CREATE UNIQUE INDEX assistant_candidate_selection_current_idx
    ON public.assistant_candidate_selection(owner_id, contact_id, session_id) WHERE is_current;

CREATE FUNCTION public.valid_assistant_candidate_edit_group(original_group jsonb, edited_group jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE aggregate_text text; message_number integer;
BEGIN
    IF coalesce(jsonb_typeof(original_group) <> 'array', TRUE)
       OR coalesce(jsonb_typeof(edited_group) <> 'array', TRUE) THEN RETURN false; END IF;
    IF jsonb_array_length(original_group) <> jsonb_array_length(edited_group)
       OR jsonb_array_length(edited_group) NOT BETWEEN 1 AND 8 THEN RETURN false; END IF;
    SELECT string_agg(item->>'text', E'\n\n' ORDER BY ordinal)
    INTO aggregate_text FROM jsonb_array_elements(edited_group) WITH ORDINALITY AS items(item, ordinal);
    IF NOT coalesce(public.valid_candidate_message_group(edited_group, aggregate_text), FALSE)
    THEN RETURN false; END IF;
    FOR message_number IN 0..jsonb_array_length(original_group)-1 LOOP
        IF original_group->message_number->>'message_id' IS DISTINCT FROM
           edited_group->message_number->>'message_id' THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
END;
$$;

CREATE FUNCTION public.require_assistant_candidate_version_origin()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original_group jsonb; parent_number integer;
BEGIN
    SELECT candidate.message_group INTO original_group
    FROM public.reply_candidate AS candidate
    JOIN public.reply_request AS request ON request.id = candidate.reply_request_id
    JOIN public.assistant_session_turn AS turn ON turn.reply_request_id = request.id
    WHERE candidate.id = NEW.candidate_id
      AND candidate.owner_id = NEW.owner_id AND candidate.contact_id = NEW.contact_id
      AND turn.id = NEW.turn_id AND turn.session_id = NEW.session_id
      AND turn.owner_id = NEW.owner_id AND turn.contact_id = NEW.contact_id
      AND turn.state = 'completed' AND request.state = 'completed'
      AND NOT EXISTS (
          SELECT 1 FROM public.reply_invalidated_key AS invalidated
          WHERE invalidated.owner_id = NEW.owner_id AND invalidated.contact_id = NEW.contact_id
            AND invalidated.idempotency_key = request.idempotency_key
      );
    IF NOT FOUND THEN RAISE EXCEPTION '候选不属于当前有效助手会话。'; END IF;
    IF NEW.version_number > 0 THEN
        IF NOT public.valid_assistant_candidate_edit_group(original_group, NEW.message_group)
        THEN RAISE EXCEPTION '编辑必须保留原候选整组消息的身份和顺序。'; END IF;
        SELECT version_number INTO parent_number FROM public.assistant_candidate_version
        WHERE id = NEW.parent_version_id AND candidate_id = NEW.candidate_id
          AND session_id = NEW.session_id AND owner_id = NEW.owner_id AND contact_id = NEW.contact_id;
        IF NOT FOUND OR parent_number >= NEW.version_number
        THEN RAISE EXCEPTION '父版本无效。'; END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER assistant_candidate_version_origin BEFORE INSERT OR UPDATE
    ON public.assistant_candidate_version FOR EACH ROW
    EXECUTE FUNCTION public.require_assistant_candidate_version_origin();

COMMENT ON TABLE public.assistant_candidate_version IS
    '原版只引用reply_candidate权威消息组；编辑版保存整组文字、稳定逐条身份、父版和用户本次要求。';
COMMENT ON TABLE public.assistant_candidate_selection IS
    '仅用户明确点击候选和版本时记录；默认展示、复制、编辑和同步不代表选择、发送或长期偏好。';
COMMENT ON COLUMN public.assistant_candidate_version.version_number IS
    '同一候选下的展示序号，UUID才是操作身份；不按生成时间或数组位置推断版本。';
COMMENT ON COLUMN public.assistant_candidate_selection.selection_number IS
    '同一助手会话内的明确选择次序；恢复按此顺序读取实际选择，不使用默认展示代替。';
COMMENT ON COLUMN public.assistant_candidate_selection.is_current IS
    '仅显式新选择原子更新的当前投影；当前选择删除后为空，不回退或复活历史选择。';

COMMIT;
