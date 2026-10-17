BEGIN;

-- 只建立显式升级的工作状态，不重填证明、不移动既有提取水位。
ALTER TABLE public.background_task DROP CONSTRAINT background_task_task_type_check;
ALTER TABLE public.background_task ADD CONSTRAINT background_task_task_type_check
    CHECK (task_type IN ('import','delete','observation','skill_learning','memory_upgrade'));
ALTER TABLE public.background_task DROP CONSTRAINT background_task_observation_source_check;
ALTER TABLE public.background_task ADD CONSTRAINT background_task_observation_source_check
    CHECK ((task_type IN ('observation','skill_learning','memory_upgrade') AND source_document_id IS NULL)
        OR (task_type IN ('import','delete') AND source_document_id IS NOT NULL));
ALTER TABLE public.background_task DROP CONSTRAINT background_task_current_step_check;
ALTER TABLE public.background_task ADD CONSTRAINT background_task_current_step_check
    CHECK (current_step IN ('parse','normalize','extract_memory','index','verify',
        'mark_deleted','delete_derived','delete_index','clear_cache','verify_not_retrievable',
        'propose_skill','verify_skill_drafts','preview_upgrade','verify_upgrade_preview',
        'apply_upgrade','verify_upgrade_apply'));
ALTER TABLE public.background_task_step DROP CONSTRAINT background_task_step_step_name_check;
ALTER TABLE public.background_task_step ADD CONSTRAINT background_task_step_step_name_check
    CHECK (step_name IN ('parse','normalize','extract_memory','index','verify',
        'mark_deleted','delete_derived','delete_index','clear_cache','verify_not_retrievable',
        'propose_skill','verify_skill_drafts','preview_upgrade','verify_upgrade_preview',
        'apply_upgrade','verify_upgrade_apply'));

CREATE TABLE public.memory_upgrade_job (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    contact_id uuid,
    scope_kind text NOT NULL CHECK (scope_kind IN ('contact','owner')),
    operation_key uuid NOT NULL,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','cancelled','deleted')),
    message_limit integer NOT NULL CHECK (message_limit BETWEEN 1 AND 200),
    batch_size integer NOT NULL CHECK (batch_size BETWEEN 1 AND 20),
    model_call_limit integer NOT NULL CHECK (model_call_limit BETWEEN 1 AND 40),
    model_calls_used integer NOT NULL DEFAULT 0 CHECK (model_calls_used BETWEEN 0 AND model_call_limit),
    algorithm jsonb CHECK (algorithm IS NULL OR (jsonb_typeof(algorithm)='object'
        AND algorithm->>'version'='1' AND algorithm->>'digest' ~ '^[0-9a-f]{64}$')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(owner_id,operation_key),
    UNIQUE(id,owner_id),
    FOREIGN KEY(owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE,
    CHECK ((scope_kind='contact' AND contact_id IS NOT NULL) OR (scope_kind='owner' AND contact_id IS NULL))
);

CREATE TABLE public.memory_upgrade_batch (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    task_id uuid NOT NULL UNIQUE,
    trace_id uuid,
    batch_number integer NOT NULL CHECK (batch_number BETWEEN 1 AND 200),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    state text NOT NULL DEFAULT 'queued' CHECK (state IN
        ('queued','ready','apply_queued','applied','undone','failed','invalidated')),
    message_ids uuid[] NOT NULL,
    source_generation jsonb NOT NULL,
    memory_generation jsonb,
    extracted_outcome jsonb,
    comparison jsonb,
    adjudications jsonb,
    applied_records jsonb,
    algorithm jsonb CHECK (algorithm IS NULL OR (jsonb_typeof(algorithm)='object'
        AND algorithm->>'version'='1' AND algorithm->>'digest' ~ '^[0-9a-f]{64}$')),
    dependency_ids uuid[] NOT NULL,
    error_code text CHECK (error_code IN ('temporary_failure','budget_exhausted','sources_changed','memory_changed','comparison_changed','algorithm_changed','trace_write_failed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(job_id,batch_number),
    FOREIGN KEY(job_id,owner_id) REFERENCES public.memory_upgrade_job(id,owner_id) ON DELETE CASCADE,
    FOREIGN KEY(owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE,
    FOREIGN KEY(task_id,owner_id,contact_id) REFERENCES public.background_task(id,owner_id,contact_id) ON DELETE CASCADE,
    FOREIGN KEY(trace_id,owner_id,contact_id) REFERENCES public.memory_extraction_trace(trace_id,owner_id,contact_id),
    CHECK (state<>'invalidated' OR (cardinality(message_ids)=0 AND source_generation='{}'
        AND memory_generation IS NULL AND extracted_outcome IS NULL AND comparison IS NULL
        AND adjudications IS NULL AND applied_records IS NULL AND trace_id IS NULL AND cardinality(dependency_ids)=0))
);
CREATE FUNCTION public.validate_memory_upgrade_batch_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.memory_upgrade_job j
        JOIN public.background_task t ON t.id=NEW.task_id AND t.owner_id=NEW.owner_id AND t.contact_id=NEW.contact_id
        WHERE j.id=NEW.job_id AND j.owner_id=NEW.owner_id
          AND (j.scope_kind='owner' OR j.contact_id=NEW.contact_id) AND t.task_type='memory_upgrade') THEN
        RAISE check_violation USING MESSAGE='升级批次必须属于同一明确范围和固定任务';
    END IF;
    RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.validate_memory_upgrade_batch_scope() IS '校验批次实际联系人、工作主体和固定任务类型，不能仅依赖owner外键。';
CREATE TRIGGER memory_upgrade_batch_scope BEFORE INSERT OR UPDATE OF job_id,owner_id,contact_id,task_id
    ON public.memory_upgrade_batch FOR EACH ROW EXECUTE FUNCTION public.validate_memory_upgrade_batch_scope();
CREATE INDEX memory_upgrade_batch_dependencies ON public.memory_upgrade_batch USING gin(dependency_ids);

CREATE TABLE public.memory_upgrade_operation (
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    operation_key uuid NOT NULL,
    job_id uuid NOT NULL,
    action text NOT NULL CHECK (action IN ('apply','cancel','resume','undo','delete')),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    PRIMARY KEY(owner_id,operation_key),
    FOREIGN KEY(job_id,owner_id) REFERENCES public.memory_upgrade_job(id,owner_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.memory_upgrade_job IS '用户明确范围与预算的升级工作状态；不会自动重跑业务资料，不改既有水位。';
COMMENT ON COLUMN public.memory_upgrade_job.id IS '升级工作身份。';
COMMENT ON COLUMN public.memory_upgrade_job.owner_id IS '已验证用户。';
COMMENT ON COLUMN public.memory_upgrade_job.contact_id IS '联系人范围的唯一联系人；本人范围为空。';
COMMENT ON COLUMN public.memory_upgrade_job.scope_kind IS '联系人资料或独立本人资料，不能混写主体。';
COMMENT ON COLUMN public.memory_upgrade_job.operation_key IS '明确准备动作的幂等身份。';
COMMENT ON COLUMN public.memory_upgrade_job.revision IS '用户动作及来源失效的工作修订。';
COMMENT ON COLUMN public.memory_upgrade_job.state IS '活动、已取消或已删除。';
COMMENT ON COLUMN public.memory_upgrade_job.message_limit IS '用户明确的总消息上限。';
COMMENT ON COLUMN public.memory_upgrade_job.batch_size IS '每批目标消息上限，不截断单条消息。';
COMMENT ON COLUMN public.memory_upgrade_job.model_call_limit IS '包含重试的实际模型调用上限，不自动追加。';
COMMENT ON COLUMN public.memory_upgrade_job.model_calls_used IS '许可后、调用前原子预扣预算；发送前追踪失败保留已扣额度，恢复不重置，真实外发另见台账。';
COMMENT ON COLUMN public.memory_upgrade_job.created_at IS '工作创建时间。';
COMMENT ON COLUMN public.memory_upgrade_job.algorithm IS '本次明确准备绑定的实际Grounded、独立V、采纳规则及非秘密生效配置身份；旧空值不补签。';
COMMENT ON TABLE public.memory_upgrade_batch IS '同一实际联系人来源的有界比较与应用批次；私人预演与事实库分离。';
COMMENT ON COLUMN public.memory_upgrade_batch.id IS '批次身份，也作为重试的确定性提案命名空间。';
COMMENT ON COLUMN public.memory_upgrade_batch.job_id IS '同用户的明确升级工作。';
COMMENT ON COLUMN public.memory_upgrade_batch.owner_id IS '批次用户。';
COMMENT ON COLUMN public.memory_upgrade_batch.contact_id IS '实际消息所属联系人；本人工作也按真实来源分批。';
COMMENT ON COLUMN public.memory_upgrade_batch.task_id IS '同范围的原固定后台任务，批准前只运行比较步骤。';
COMMENT ON COLUMN public.memory_upgrade_batch.trace_id IS '最近真实预览或批准应用的同范围完整追踪；全部尝试以run_id关联本批，删除工作时一并清正文。';
COMMENT ON COLUMN public.memory_upgrade_batch.batch_number IS '工作内稳定顺序。';
COMMENT ON COLUMN public.memory_upgrade_batch.revision IS '比较、应用及删除修订；旧批准不可批准新内容。';
COMMENT ON COLUMN public.memory_upgrade_batch.state IS '待比较、可审核、待应用、已应用、已撤销、失败或失效。';
COMMENT ON COLUMN public.memory_upgrade_batch.message_ids IS '本批完整目标消息身份，删除时清除。';
COMMENT ON COLUMN public.memory_upgrade_batch.source_generation IS '新捕获的无正文完整窗口代际，不为旧证明倒填。';
COMMENT ON COLUMN public.memory_upgrade_batch.memory_generation IS '比较时原资料与人工决定集合摘要及无正文来源世代，应用前必须一致。';
COMMENT ON COLUMN public.memory_upgrade_batch.extracted_outcome IS '独立新提取的临时结果，尚未写入事实库。';
COMMENT ON COLUMN public.memory_upgrade_batch.comparison IS '用户查看的当前与新结果、预计处理方式。';
COMMENT ON COLUMN public.memory_upgrade_batch.adjudications IS '本批已用模型作出的裁决回执，应用重放不再调用模型。';
COMMENT ON COLUMN public.memory_upgrade_batch.applied_records IS '本批实际新建或更新的身份与修订，仅用于合法撤销。';
COMMENT ON COLUMN public.memory_upgrade_batch.dependency_ids IS '消息、来源、原资料及人工决定的完整删除依赖。';
COMMENT ON COLUMN public.memory_upgrade_batch.error_code IS '无正文的有限失败分类。';
COMMENT ON COLUMN public.memory_upgrade_batch.created_at IS '批次建立时间。';
COMMENT ON COLUMN public.memory_upgrade_batch.algorithm IS '该批预览和明确批准的算法身份；批准、领取和最晚写入均复验，不从trace补签。';
COMMENT ON TABLE public.memory_upgrade_operation IS '明确应用、取消、恢复、撤销与删除动作的无正文幂等回执。';
COMMENT ON COLUMN public.memory_upgrade_operation.owner_id IS '动作所属用户。';
COMMENT ON COLUMN public.memory_upgrade_operation.operation_key IS '明确用户动作的稳定身份。';
COMMENT ON COLUMN public.memory_upgrade_operation.job_id IS '同用户的工作身份。';
COMMENT ON COLUMN public.memory_upgrade_operation.action IS '受限工作动作，不允许任意工具。';
COMMENT ON COLUMN public.memory_upgrade_operation.request_digest IS '原动作参数摘要，禁止复用同键执行不同批准。';
COMMIT;
