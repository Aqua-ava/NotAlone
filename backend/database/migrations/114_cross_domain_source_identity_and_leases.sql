BEGIN;

-- 旧删除凭证只按 broad source 标识目标；补足来源类型和租约代次，保留此前已应用的历史。
ALTER TABLE public.cross_domain_deletion_operation
    ADD COLUMN source_kind text
        CHECK (source_kind IN ('source_document', 'local_wechat_observation')),
    ADD COLUMN lease_generation bigint NOT NULL DEFAULT 0
        CHECK (lease_generation >= 0);

ALTER TABLE public.cross_domain_deletion_operation
    DROP CONSTRAINT cross_domain_deletion_operation_check;

ALTER TABLE public.cross_domain_deletion_operation
    ADD CONSTRAINT cross_domain_deletion_operation_check CHECK (
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
    );

-- 排队中的来源文档与本地观察都必须阻止迟到引用，不能再借旧实现复活。
CREATE OR REPLACE FUNCTION public.notalone_reject_inactive_source_ref()
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

DROP TRIGGER message_source_ref_active_source ON public.message_source_ref;
CREATE TRIGGER message_source_ref_active_source
BEFORE INSERT OR UPDATE OF source_document_id, observation_id, owner_id, contact_id
ON public.message_source_ref
FOR EACH ROW EXECUTE FUNCTION public.notalone_reject_inactive_source_ref();

COMMIT;
