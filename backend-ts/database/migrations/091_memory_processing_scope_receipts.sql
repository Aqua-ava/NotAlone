BEGIN;
-- 090 已在开发环境应用，使用前向迁移补充范围约束和完成结果，不改旧账本。
CREATE UNIQUE INDEX background_task_processing_scope_idx
    ON public.background_task(id, owner_id, contact_id);
ALTER TABLE public.memory_processing_plan
    ADD COLUMN owner_id uuid,
    ADD COLUMN contact_id uuid;
UPDATE public.memory_processing_plan p SET owner_id=t.owner_id,contact_id=t.contact_id
    FROM public.background_task t WHERE t.id=p.task_id;
ALTER TABLE public.memory_processing_plan
    ALTER COLUMN owner_id SET NOT NULL,
    ALTER COLUMN contact_id SET NOT NULL,
    ADD UNIQUE (task_id,owner_id,contact_id),
    ADD FOREIGN KEY (task_id,owner_id,contact_id)
        REFERENCES public.background_task(id,owner_id,contact_id) ON DELETE CASCADE;
ALTER TABLE public.memory_processing_target
    ADD COLUMN owner_id uuid,
    ADD COLUMN contact_id uuid,
    ADD COLUMN outcome text CHECK (outcome IN ('succeeded','skipped','unknown'));
UPDATE public.memory_processing_target x SET owner_id=p.owner_id,contact_id=p.contact_id
    FROM public.memory_processing_plan p WHERE p.task_id=x.task_id;
ALTER TABLE public.memory_processing_target
    ALTER COLUMN owner_id SET NOT NULL,
    ALTER COLUMN contact_id SET NOT NULL,
    ADD FOREIGN KEY (task_id,owner_id,contact_id)
        REFERENCES public.memory_processing_plan(task_id,owner_id,contact_id) ON DELETE CASCADE,
    ADD FOREIGN KEY (message_id,owner_id,contact_id)
        REFERENCES public.message(id,owner_id,contact_id) ON DELETE CASCADE;
CREATE INDEX memory_processing_target_message_idx ON public.memory_processing_target(message_id);
ALTER TABLE public.memory_processing_receipt
    ADD COLUMN owner_id uuid,
    ADD COLUMN contact_id uuid,
    ADD COLUMN outcome text NOT NULL DEFAULT 'unknown'
        CHECK (outcome IN ('succeeded','skipped','unknown'));
UPDATE public.memory_processing_receipt r SET owner_id=m.owner_id,contact_id=m.contact_id
    FROM public.message m WHERE m.id=r.message_id;
ALTER TABLE public.memory_processing_receipt
    ALTER COLUMN owner_id SET NOT NULL,
    ALTER COLUMN contact_id SET NOT NULL,
    ADD FOREIGN KEY (message_id,owner_id,contact_id)
        REFERENCES public.message(id,owner_id,contact_id) ON DELETE CASCADE;
-- 只按仍存在的批次证据还原结果；追踪已删时保留 unknown，不假报成功。
WITH latest AS (
    SELECT DISTINCT ON (m.id) m.id,t.status
    FROM public.memory_extraction_trace t
    JOIN public.memory_extraction_trace_event e ON e.trace_id=t.trace_id AND e.stage='window'
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(e.payload->'target_message_ids','[]')) ids(value)
    JOIN public.message m ON m.id=ids.value::uuid AND m.owner_id=t.owner_id AND m.contact_id=t.contact_id
    WHERE t.status IN ('succeeded','skipped')
    ORDER BY m.id,t.finished_at DESC
)
UPDATE public.memory_processing_receipt r SET outcome=latest.status FROM latest WHERE latest.id=r.message_id;
UPDATE public.memory_processing_target x SET outcome=COALESCE(r.outcome,'unknown')
    FROM public.memory_processing_receipt r WHERE x.message_id=r.message_id AND x.completed_at IS NOT NULL;
UPDATE public.memory_processing_target SET outcome='unknown' WHERE completed_at IS NOT NULL AND outcome IS NULL;
COMMIT;
