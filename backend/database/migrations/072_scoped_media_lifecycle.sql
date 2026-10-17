BEGIN;

-- 文件清理归属故意不依赖业务对象的 CASCADE；先清文件再移除登记。
CREATE TABLE public.media_attempt (
    resource_id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    message_id uuid NOT NULL,
    source_ref_id uuid NOT NULL,
    source_document_id uuid NOT NULL,
    request_key_hash text NOT NULL,
    input_hash text NOT NULL,
    target text NOT NULL,
    variant text,
    locator_hash text,
    authorization_generation text NOT NULL,
    attempt_id uuid NOT NULL,
    cache_root text NOT NULL,
    status text NOT NULL CHECK (status IN ('preparing','ready','failed','cleanup_pending')),
    error_code text,
    artifacts jsonb NOT NULL DEFAULT '[]'::jsonb,
    lease_expires_at timestamptz NOT NULL,
    UNIQUE (owner_id,contact_id,request_key_hash)
);
CREATE INDEX media_attempt_source_idx ON public.media_attempt (owner_id,contact_id,source_document_id);
COMMENT ON TABLE public.media_attempt IS
    '显式单条媒体请求、代次和持久清理清单；不因业务对象级联删除而丢失文件归属。';

CREATE TABLE public.media_request_tombstone (
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    request_key_hash text NOT NULL,
    PRIMARY KEY (owner_id,contact_id,request_key_hash)
);
COMMENT ON TABLE public.media_request_tombstone IS
    '来源失效后阻止旧幂等键改挂其他来源；仅保留范围及请求键摘要，不含来源定位或文件清单。';

COMMIT;
