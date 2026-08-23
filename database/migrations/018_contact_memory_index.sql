BEGIN;

CREATE TABLE IF NOT EXISTS public.contact_memory_state (
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    memory_revision bigint NOT NULL DEFAULT 0 CHECK (memory_revision >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, contact_id),
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.contact_memory_index (
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    built_from_memory_revision bigint NOT NULL
        CHECK (built_from_memory_revision >= 0),
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'stale')),
    topics jsonb NOT NULL
        CHECK (
            jsonb_typeof(topics) = 'array'
            AND jsonb_array_length(topics) <= 20
        ),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, contact_id),
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE
);

INSERT INTO public.contact_memory_state (owner_id, contact_id)
SELECT contact.owner_id, contact.id
FROM public.contact
ON CONFLICT (owner_id, contact_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS contact_memory_index_revision_idx
    ON public.contact_memory_index (
        owner_id,
        contact_id,
        built_from_memory_revision,
        updated_at DESC
    );

COMMENT ON TABLE public.contact_memory_state IS
    '联系人级关系记忆单调 revision；用于检测目录是否过期。';
COMMENT ON COLUMN public.contact_memory_state.memory_revision IS
    '联系人 confirmed_memory 发生变化后的单调版本号。';
COMMENT ON TABLE public.contact_memory_index IS
    '当前联系人有效关系记忆的可重建主题目录，不是新的事实源。';
COMMENT ON COLUMN public.contact_memory_index.built_from_memory_revision IS
    '该目录投影所读取的联系人记忆版本。';
COMMENT ON COLUMN public.contact_memory_index.topics IS
    '只含分类、主题提示和 confirmed_memory UUID 引用的 JSON 数组，不含正文。';

COMMIT;
