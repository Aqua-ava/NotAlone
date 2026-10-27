BEGIN;

-- 存量接入只保存管理决定与原任务身份；不上传或复制聊天正文，也不改写旧任务结果。
CREATE TABLE public.memory_processing_legacy_adoption (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    contact_id uuid,
    scope_id uuid NOT NULL UNIQUE REFERENCES public.memory_processing_scope(id) ON DELETE CASCADE,
    round_id uuid NOT NULL UNIQUE REFERENCES public.memory_processing_round(id) ON DELETE CASCADE,
    task_id uuid UNIQUE REFERENCES public.background_task(id) ON DELETE CASCADE,
    decision text NOT NULL CHECK(decision IN ('adopted','unresolved')),
    evidence_code text NOT NULL CHECK(length(btrim(evidence_code))>0),
    resume_required boolean NOT NULL DEFAULT false,
    reason_code text,
    adopted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    resumed_at timestamptz,
    CHECK(
        decision='adopted' AND task_id IS NOT NULL AND reason_code IS NULL
        AND (resume_required AND resumed_at IS NULL OR NOT resume_required AND resumed_at IS NOT NULL)
        OR decision='unresolved' AND task_id IS NULL AND NOT resume_required AND reason_code IS NOT NULL
    ),
    FOREIGN KEY(scope_id,round_id) REFERENCES public.memory_processing_round(scope_id,id) ON DELETE CASCADE,
    FOREIGN KEY(owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE
);

CREATE INDEX memory_processing_legacy_adoption_scope
    ON public.memory_processing_legacy_adoption(owner_id,contact_id);

COMMENT ON TABLE public.memory_processing_legacy_adoption IS
    '旧记忆任务的可验证接入决定；adopted 保留原任务并要求一次显式继续，unresolved 仅阻止未证明安全的领取。';

COMMIT;
