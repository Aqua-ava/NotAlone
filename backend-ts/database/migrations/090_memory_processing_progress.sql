BEGIN;
-- 只存任务范围和消息标识；与正文分离，任务/消息删除时一并清除。
CREATE TABLE public.memory_processing_plan (
    task_id uuid PRIMARY KEY REFERENCES public.background_task(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.memory_processing_target (
    task_id uuid NOT NULL REFERENCES public.memory_processing_plan(task_id) ON DELETE CASCADE,
    message_id uuid NOT NULL REFERENCES public.message(id) ON DELETE CASCADE,
    completed_at timestamptz,
    PRIMARY KEY (task_id, message_id)
);
CREATE TABLE public.memory_processing_receipt (
    message_id uuid PRIMARY KEY REFERENCES public.message(id) ON DELETE CASCADE,
    completed_at timestamptz NOT NULL DEFAULT now()
);
-- 仅迁移仍存在的成功批次证据；已删除追踪不推断完成量。
INSERT INTO public.memory_processing_receipt(message_id, completed_at)
SELECT DISTINCT ON (m.id) m.id, COALESCE(t.finished_at,t.started_at)
FROM public.memory_extraction_trace t
JOIN public.memory_extraction_trace_event e ON e.trace_id=t.trace_id AND e.stage='window'
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(e.payload->'target_message_ids','[]')) ids(value)
JOIN public.message m ON m.id=ids.value::uuid AND m.owner_id=t.owner_id AND m.contact_id=t.contact_id
WHERE t.status IN ('succeeded','skipped')
ORDER BY m.id,t.finished_at DESC
ON CONFLICT DO NOTHING;
COMMIT;
