BEGIN;

-- 用户自身事实的 owner 级记忆；无联系人归属，软删除保留文本指纹。
CREATE TABLE public.owner_memory (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    text_content text NOT NULL CHECK (length(btrim(text_content)) > 0),
    category text NOT NULL CHECK (category IN (
        'common_fact',
        'preference',
        'taboo',
        'recent_state',
        'relationship_note'
    )),
    topic text NOT NULL DEFAULT 'other' CHECK (topic IN (
        'health', 'work', 'family', 'travel',
        'finance', 'study', 'emotion', 'other'
    )),
    source_ids uuid[] NOT NULL CHECK (cardinality(source_ids) >= 1),
    adoption_method text NOT NULL CHECK (adoption_method IN ('auto', 'manual')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN (
        'active',
        'invalidated',
        'deleted'
    )),
    valid_at timestamptz,
    invalid_at timestamptz,
    revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.owner_memory IS
    '用户自身事实的 owner 级记忆（主体恒为 self）；软删除行保留文本指纹，'
    '用于阻止已删除记忆经自动提取复活。';

CREATE INDEX owner_memory_owner_idx ON public.owner_memory (owner_id, status);

COMMIT;
