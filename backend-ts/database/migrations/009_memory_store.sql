BEGIN;

CREATE TABLE public.memory_candidate (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    text_content text NOT NULL CHECK (length(btrim(text_content)) > 0),
    category text NOT NULL CHECK (category IN (
        'common_fact',
        'preference',
        'taboo',
        'recent_state',
        'relationship_note'
    )),
    source_ids uuid[] NOT NULL CHECK (cardinality(source_ids) >= 1),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'confirmed',
        'rejected',
        'invalidated'
    )),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE,
    UNIQUE (owner_id, contact_id, id)
);

CREATE TABLE public.confirmed_memory (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    text_content text NOT NULL CHECK (length(btrim(text_content)) > 0),
    category text NOT NULL CHECK (category IN (
        'common_fact',
        'preference',
        'taboo',
        'recent_state',
        'relationship_note'
    )),
    source_ids uuid[] NOT NULL CHECK (cardinality(source_ids) >= 1),
    source_candidate_id uuid,
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
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE,
    FOREIGN KEY (owner_id, contact_id, source_candidate_id)
        REFERENCES public.memory_candidate(owner_id, contact_id, id)
        ON DELETE CASCADE,
    UNIQUE (owner_id, contact_id, id),
    UNIQUE (owner_id, contact_id, source_candidate_id)
);

CREATE INDEX memory_candidate_scope_status_idx
    ON public.memory_candidate (owner_id, contact_id, status, updated_at DESC);

CREATE INDEX confirmed_memory_scope_status_idx
    ON public.confirmed_memory (
        owner_id,
        contact_id,
        status,
        valid_at,
        invalid_at,
        updated_at DESC
    );

CREATE INDEX confirmed_memory_source_ids_gin_idx
    ON public.confirmed_memory USING gin (source_ids);

COMMENT ON TABLE public.memory_candidate IS
    '待处理关系记忆候选；只保存带联系人范围、分类和来源 UUID 的结构化候选。';
COMMENT ON COLUMN public.memory_candidate.text_content IS
    '关系记忆候选正文，不保存完整聊天历史。';
COMMENT ON COLUMN public.memory_candidate.source_ids IS
    '支持该候选的来源 UUID 列表；具体来源类型由上游适配器解释。';
COMMENT ON COLUMN public.memory_candidate.status IS
    '候选状态：pending、confirmed、rejected 或 invalidated。';
COMMENT ON TABLE public.confirmed_memory IS
    '已确认关系记忆；必须保留来源、采纳方式、有效期和可递增修订号。';
COMMENT ON COLUMN public.confirmed_memory.source_candidate_id IS
    '产生该记忆的候选 UUID；手动记忆路径可为空。';
COMMENT ON COLUMN public.confirmed_memory.adoption_method IS
    '采纳方式：auto 或 manual；auto 不表示用户人工确认。';
COMMENT ON COLUMN public.confirmed_memory.status IS
    '记忆状态：active、invalidated 或 deleted；只有 active 且有效期内的记录可检索。';
COMMENT ON COLUMN public.confirmed_memory.valid_at IS
    '记忆生效时间；为空表示从采纳时起有效。';
COMMENT ON COLUMN public.confirmed_memory.invalid_at IS
    '记忆失效时间；达到该时间后不再进入回复上下文。';
COMMENT ON COLUMN public.confirmed_memory.revision IS
    '该记忆正文、分类、状态或有效期发生变化后的单调递增修订号。';

COMMIT;
