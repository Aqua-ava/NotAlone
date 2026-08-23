BEGIN;

-- 受控主题进入联系人级记忆管线，供写入裁决粗筛使用。
ALTER TABLE public.memory_candidate
    ADD COLUMN topic text NOT NULL DEFAULT 'other'
    CHECK (topic IN (
        'health', 'work', 'family', 'travel',
        'finance', 'study', 'emotion', 'other'
    ));

ALTER TABLE public.confirmed_memory
    ADD COLUMN topic text NOT NULL DEFAULT 'other'
    CHECK (topic IN (
        'health', 'work', 'family', 'travel',
        'finance', 'study', 'emotion', 'other'
    ));

-- 每个联系人的提取水位：已提取到的最后一条消息，重跑从此继续。
CREATE TABLE public.memory_extraction_watermark (
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    last_message_id uuid NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, contact_id)
);

COMMENT ON TABLE public.memory_extraction_watermark IS
    '记忆提取的联系人级水位；断点重跑从水位之后的消息继续。';

COMMIT;
