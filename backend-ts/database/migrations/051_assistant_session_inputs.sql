BEGIN;

ALTER TABLE public.assistant_session_turn
    ADD CONSTRAINT assistant_session_turn_input_scope_unique
    UNIQUE (input_version_id, id, session_id, owner_id, contact_id);

CREATE TABLE public.assistant_session_input (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    conversation_binding_id uuid NOT NULL,
    input_type text NOT NULL
        CHECK (input_type IN ('generation', 'response_exploration', 'purpose_exploration')),
    turn_id uuid UNIQUE,
    content jsonb CHECK (content IS NULL OR jsonb_typeof(content) = 'object'),
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'redacted')),
    dependency_ids uuid[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (session_id, owner_id, contact_id)
        REFERENCES public.assistant_session(id, owner_id, contact_id) ON DELETE CASCADE,
    FOREIGN KEY (id, turn_id, session_id, owner_id, contact_id)
        REFERENCES public.assistant_session_turn(input_version_id, id, session_id, owner_id, contact_id)
        ON DELETE CASCADE,
    UNIQUE (id, session_id, owner_id, contact_id),
    CHECK (
        (input_type = 'generation' AND turn_id IS NOT NULL AND content IS NULL
            AND cardinality(dependency_ids) = 0)
        OR (input_type <> 'generation' AND turn_id IS NULL
            AND ((state = 'active' AND content IS NOT NULL
                    AND coalesce(content ->> 'type' = input_type, FALSE))
                OR (state = 'redacted' AND content IS NULL
                    AND cardinality(dependency_ids) = 0)))
    )
);

CREATE INDEX assistant_session_input_order_idx
    ON public.assistant_session_input (owner_id, contact_id, session_id, created_at, id);
CREATE INDEX assistant_session_input_dependencies_idx
    ON public.assistant_session_input USING gin (dependency_ids);

INSERT INTO public.assistant_session_input
    (id, session_id, owner_id, contact_id, conversation_binding_id,
     input_type, turn_id, state, created_at, updated_at)
SELECT input_version_id, session_id, owner_id, contact_id, conversation_binding_id,
       'generation', id, CASE WHEN state = 'redacted' THEN 'redacted' ELSE 'active' END,
       created_at, updated_at
FROM public.assistant_session_turn;

ALTER TABLE public.assistant_session ADD COLUMN current_input_version_id uuid;

UPDATE public.assistant_session AS session
SET current_input_version_id = latest.id
FROM (
    SELECT DISTINCT ON (session_id) session_id, id
    FROM public.assistant_session_input
    ORDER BY session_id, created_at DESC, turn_id DESC
) AS latest
WHERE session.id = latest.session_id;

ALTER TABLE public.assistant_session
    ADD CONSTRAINT assistant_session_current_input_scope_fk
    FOREIGN KEY (current_input_version_id, id, owner_id, contact_id)
    REFERENCES public.assistant_session_input(id, session_id, owner_id, contact_id)
    ON DELETE SET NULL (current_input_version_id);

COMMENT ON TABLE public.assistant_session_input IS
    '助手会话的稳定输入版本；讨论保留用户输入，生成仅关联既有turn，不复制正文。';
COMMENT ON COLUMN public.assistant_session.current_input_version_id IS
    '本会话唯一当前输入指针；旧请求重放不会回退，来源失效不自动恢复早期输入。';
COMMENT ON COLUMN public.assistant_session_input.dependency_ids IS
    '讨论实际捕获的消息与来源依赖；生成依赖仍由关联turn持有。';

COMMIT;
