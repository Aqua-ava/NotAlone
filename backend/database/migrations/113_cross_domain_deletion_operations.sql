BEGIN;

-- 删除凭证独立于业务对象；联系人、账户被物理删除后仍需能复读失败或完成结果。
CREATE TABLE public.cross_domain_deletion_operation (
    id uuid PRIMARY KEY,
    subject_sha256 text NOT NULL UNIQUE
        CHECK (subject_sha256 ~ '^[0-9a-f]{64}$'),
    scope_kind text NOT NULL
        CHECK (scope_kind IN ('source', 'contact', 'account', 'discussion')),
    source_kind text
        CHECK (source_kind IN ('source_document', 'local_wechat_observation')),
    owner_id uuid,
    contact_id uuid,
    target_id uuid,
    status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'verifying', 'succeeded', 'failed')),
    phase text NOT NULL DEFAULT 'invalidate'
        CHECK (phase IN ('invalidate', 'erase', 'file_cleanup', 'verify', 'complete')),
    error_code text,
    lease_expires_at timestamptz,
    lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
    confirmed_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    CHECK (
        (scope_kind = 'source' AND source_kind IS NOT NULL
            AND owner_id IS NOT NULL AND contact_id IS NOT NULL AND target_id IS NOT NULL)
        OR (scope_kind = 'discussion' AND source_kind IS NULL
            AND owner_id IS NOT NULL AND contact_id IS NOT NULL AND target_id IS NOT NULL)
        OR (scope_kind = 'contact' AND source_kind IS NULL
            AND owner_id IS NOT NULL AND contact_id IS NOT NULL AND target_id = contact_id)
        OR (scope_kind = 'account' AND source_kind IS NULL
            AND owner_id IS NOT NULL AND contact_id IS NULL AND target_id = owner_id)
        OR (status = 'succeeded' AND source_kind IS NULL
            AND owner_id IS NULL AND contact_id IS NULL AND target_id IS NULL)
    ),
    CHECK (status <> 'succeeded' OR (phase = 'complete' AND error_code IS NULL AND finished_at IS NOT NULL)),
    CHECK (status <> 'failed' OR (error_code IS NOT NULL AND finished_at IS NOT NULL))
);

CREATE INDEX cross_domain_deletion_operation_status_idx
    ON public.cross_domain_deletion_operation(status, lease_expires_at, updated_at);
CREATE INDEX cross_domain_deletion_operation_owner_idx
    ON public.cross_domain_deletion_operation(owner_id, created_at DESC)
    WHERE owner_id IS NOT NULL;

COMMENT ON TABLE public.cross_domain_deletion_operation IS
    '跨存储面删除的幂等请求、租约和最小结果凭证；成功后可清空业务身份，不保存正文。';

-- 删除排队即停止任何迟到的来源引用写入；仍在写入的来源不能借旧实现复活。
CREATE FUNCTION public.notalone_reject_inactive_source_ref()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.source_document_id IS NOT NULL AND (
        EXISTS (
            SELECT 1
              FROM public.cross_domain_deletion_operation operation
             WHERE operation.scope_kind = 'source'
               AND operation.source_kind = 'source_document'
               AND operation.owner_id = NEW.owner_id
               AND operation.contact_id = NEW.contact_id
               AND operation.target_id = NEW.source_document_id
               AND operation.status IN ('queued', 'running', 'failed')
        )
        OR NOT EXISTS (
        SELECT 1
          FROM public.source_document source
         WHERE source.id = NEW.source_document_id
           AND source.owner_id = NEW.owner_id
           AND source.contact_id = NEW.contact_id
           AND source.status = 'active'
        )
    ) THEN
        RAISE EXCEPTION 'source_not_active';
    END IF;
    IF NEW.observation_id IS NOT NULL AND (
        EXISTS (
            SELECT 1
              FROM public.cross_domain_deletion_operation operation
             WHERE operation.scope_kind = 'source'
               AND operation.source_kind = 'local_wechat_observation'
               AND operation.owner_id = NEW.owner_id
               AND operation.contact_id = NEW.contact_id
               AND operation.target_id = NEW.observation_id
               AND operation.status IN ('queued', 'running', 'failed')
        )
        OR NOT EXISTS (
        SELECT 1
          FROM public.local_wechat_observation observation
         WHERE observation.id = NEW.observation_id
           AND observation.owner_id = NEW.owner_id
           AND observation.contact_id = NEW.contact_id
        )
    ) THEN
        RAISE EXCEPTION 'source_not_active';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER message_source_ref_active_source
BEFORE INSERT OR UPDATE OF source_document_id, observation_id, owner_id, contact_id
ON public.message_source_ref
FOR EACH ROW EXECUTE FUNCTION public.notalone_reject_inactive_source_ref();

COMMIT;
