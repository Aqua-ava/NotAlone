BEGIN;

ALTER TABLE public.background_task DROP CONSTRAINT background_task_task_type_check;
ALTER TABLE public.background_task ADD CONSTRAINT background_task_task_type_check
    CHECK (task_type IN ('import','delete','observation','skill_learning'));
ALTER TABLE public.background_task DROP CONSTRAINT background_task_observation_source_check;
ALTER TABLE public.background_task ADD CONSTRAINT background_task_observation_source_check
    CHECK ((task_type IN ('observation','skill_learning') AND source_document_id IS NULL)
        OR (task_type IN ('import','delete') AND source_document_id IS NOT NULL));
ALTER TABLE public.background_task DROP CONSTRAINT background_task_current_step_check;
ALTER TABLE public.background_task ADD CONSTRAINT background_task_current_step_check
    CHECK (current_step IN ('parse','normalize','extract_memory','index','verify',
        'mark_deleted','delete_derived','delete_index','clear_cache','verify_not_retrievable',
        'propose_skill','verify_skill_drafts'));
ALTER TABLE public.background_task_step DROP CONSTRAINT background_task_step_step_name_check;
ALTER TABLE public.background_task_step ADD CONSTRAINT background_task_step_step_name_check
    CHECK (step_name IN ('parse','normalize','extract_memory','index','verify',
        'mark_deleted','delete_derived','delete_index','clear_cache','verify_not_retrievable',
        'propose_skill','verify_skill_drafts'));
CREATE UNIQUE INDEX background_task_skill_learning_scope
    ON public.background_task(owner_id,contact_id) WHERE task_type='skill_learning';
ALTER TABLE public.background_task ADD CONSTRAINT background_task_scoped_identity
    UNIQUE(id,owner_id,contact_id);

CREATE TABLE public.skill_learning_scope (
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    enabled boolean NOT NULL DEFAULT false,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    confirmed_at timestamptz,
    last_attempt_key text,
    PRIMARY KEY(owner_id,contact_id),
    FOREIGN KEY(owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE
);
CREATE TABLE public.skill_learning_operation (
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    operation_key uuid NOT NULL,
    enabled boolean NOT NULL,
    expected_revision bigint NOT NULL CHECK (expected_revision >= 0),
    result_revision bigint NOT NULL CHECK (result_revision > expected_revision),
    PRIMARY KEY(owner_id,contact_id,operation_key),
    FOREIGN KEY(owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE
);

-- 待审核草稿独立于运行Skill库；私人依据不属于可发布正文。
CREATE TABLE public.skill_draft (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rejected','published','invalidated')),
    logical_skill_id uuid NOT NULL,
    proposal_kind text NOT NULL CHECK (proposal_kind IN ('create','update','merge')),
    strategy jsonb,
    private_evidence jsonb,
    target_versions jsonb NOT NULL DEFAULT '[]',
    published_version_id uuid REFERENCES public.reply_skill_version(id),
    dependency_ids uuid[] NOT NULL DEFAULT '{}',
    source_generation jsonb NOT NULL DEFAULT '{}',
    batch_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE,
    UNIQUE(owner_id,contact_id,batch_key),
    UNIQUE(id,owner_id,contact_id),
    CHECK (status <> 'invalidated' OR (strategy IS NULL AND private_evidence IS NULL
        AND target_versions='[]' AND source_generation='{}' AND cardinality(dependency_ids)=0))
);
CREATE INDEX skill_draft_dependencies ON public.skill_draft USING gin(dependency_ids);

-- 批次与消费回执只存身份、摘要和删除依赖，不存模型输入或正文。
CREATE TABLE public.skill_learning_batch (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    task_id uuid NOT NULL,
    batch_key text NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('draft','no_change','reuse','invalidated')),
    draft_id uuid,
    dependency_ids uuid[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE,
    FOREIGN KEY(task_id,owner_id,contact_id) REFERENCES public.background_task(id,owner_id,contact_id) ON DELETE CASCADE,
    FOREIGN KEY(draft_id,owner_id,contact_id) REFERENCES public.skill_draft(id,owner_id,contact_id) ON DELETE CASCADE,
    UNIQUE(id,owner_id,contact_id),
    UNIQUE(owner_id,contact_id,batch_key)
);
CREATE TABLE public.skill_learning_receipt (
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    material_id uuid NOT NULL,
    digest text,
    batch_id uuid NOT NULL,
    PRIMARY KEY(owner_id,contact_id,material_id),
    FOREIGN KEY(owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE,
    FOREIGN KEY(batch_id,owner_id,contact_id) REFERENCES public.skill_learning_batch(id,owner_id,contact_id) ON DELETE CASCADE
);
CREATE TABLE public.skill_method_identity (
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    logical_skill_id uuid NOT NULL,
    method_id uuid NOT NULL,
    semantic_key_sha256 text NOT NULL,
    PRIMARY KEY(owner_id,method_id),
    UNIQUE(owner_id,logical_skill_id,semantic_key_sha256)
);
COMMENT ON TABLE public.skill_draft IS '授权经验的独立待审核提案；删除清空策略和私人审核依据，未审核不进入运行目录。';
COMMENT ON TABLE public.skill_learning_scope IS '用户明确开启同一联系人经验整理的新模型用途授权，可随时关闭。';
-- 后续发布仍须走审核；即使直接关联版本也不能连接其他范围。
CREATE FUNCTION public.validate_skill_draft_published_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.published_version_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.reply_skill_version AS version
        JOIN public.reply_skill AS skill ON skill.id=version.skill_id
        WHERE version.id=NEW.published_version_id AND skill.owner_id=NEW.owner_id
          AND (skill.contact_id IS NULL OR skill.contact_id=NEW.contact_id)
    ) THEN
        RAISE EXCEPTION 'skill_draft_published_scope_mismatch' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER skill_draft_published_scope BEFORE INSERT OR UPDATE ON public.skill_draft
    FOR EACH ROW EXECUTE FUNCTION public.validate_skill_draft_published_scope();

COMMENT ON TABLE public.skill_learning_scope IS '联系人学习用途的明确授权与修订；默认关闭，不等同同步读取授权。';
COMMENT ON COLUMN public.skill_learning_scope.owner_id IS '已验证用户。';
COMMENT ON COLUMN public.skill_learning_scope.contact_id IS '已确认联系人；每个用户联系人一份设置。';
COMMENT ON COLUMN public.skill_learning_scope.enabled IS '用户明确开启新的经验提案用途。';
COMMENT ON COLUMN public.skill_learning_scope.revision IS '授权集合修订，启停均递增；旧回执不得覆盖新决定。';
COMMENT ON COLUMN public.skill_learning_scope.confirmed_at IS '最近明确启停时间。';
COMMENT ON COLUMN public.skill_learning_scope.last_attempt_key IS '最近已尝试的有界批次摘要，避免轮询重复失败调用；删除时清除。';
COMMENT ON TABLE public.skill_learning_operation IS '学习授权操作的无正文幂等回执；重复启用不能覆盖后来的关闭。';
COMMENT ON COLUMN public.skill_learning_operation.owner_id IS '操作所属用户。';
COMMENT ON COLUMN public.skill_learning_operation.contact_id IS '操作所属联系人。';
COMMENT ON COLUMN public.skill_learning_operation.operation_key IS '用户动作的稳定幂等键。';
COMMENT ON COLUMN public.skill_learning_operation.enabled IS '原明确动作的目标值。';
COMMENT ON COLUMN public.skill_learning_operation.expected_revision IS '该动作读取的授权修订。';
COMMENT ON COLUMN public.skill_learning_operation.result_revision IS '该动作提交后的授权修订。';
COMMENT ON TABLE public.skill_draft IS '授权经验的独立待审核提案；未审核不进入运行目录，删除完整清空私人副本。';
COMMENT ON COLUMN public.skill_draft.id IS '草稿身份。';
COMMENT ON COLUMN public.skill_draft.owner_id IS '审核私人依据所属用户。';
COMMENT ON COLUMN public.skill_draft.contact_id IS '取材所属联系人；范围建议不改变读取权限。';
COMMENT ON COLUMN public.skill_draft.revision IS '草稿修订；后续编辑与删除必须递增。';
COMMENT ON COLUMN public.skill_draft.status IS '待审核、已拒绝、已发布或来源失效。';
COMMENT ON COLUMN public.skill_draft.logical_skill_id IS '方法延续所用逻辑Skill身份；不是运行目录的发布凭证。';
COMMENT ON COLUMN public.skill_draft.proposal_kind IS '新建、更新或合并提案。';
COMMENT ON COLUMN public.skill_draft.strategy IS '清洗后的待审核策略与方法，尚未生效。';
COMMENT ON COLUMN public.skill_draft.private_evidence IS '仅同范围审核可读的原材料与目标依据。';
COMMENT ON COLUMN public.skill_draft.target_versions IS '提案实际对照的目标Skill版本，后续发布仍须复验。';
COMMENT ON COLUMN public.skill_draft.published_version_id IS '后续经明确审核发布的版本；09不写入。';
COMMENT ON COLUMN public.skill_draft.dependency_ids IS '全部实际参与资料的删除依赖，不以展示条数裁剪。';
COMMENT ON COLUMN public.skill_draft.source_generation IS '冻结的无正文来源代际，恢复和写入必须复验。';
COMMENT ON COLUMN public.skill_draft.batch_key IS '批次去重摘要；失效清除后仅保留无正文身份。';
COMMENT ON COLUMN public.skill_draft.created_at IS '草稿形成时间。';
COMMENT ON TABLE public.skill_learning_batch IS '有限学习批次回执；无新增和复用也消费材料，不为每条消息建草稿。';
COMMENT ON COLUMN public.skill_learning_batch.id IS '批次身份。';
COMMENT ON COLUMN public.skill_learning_batch.owner_id IS '批次所属用户。';
COMMENT ON COLUMN public.skill_learning_batch.contact_id IS '批次所属联系人。';
COMMENT ON COLUMN public.skill_learning_batch.task_id IS '同用户同联系人的固定后台学习任务。';
COMMENT ON COLUMN public.skill_learning_batch.batch_key IS '实际输入与版本的去重摘要；删除时清除。';
COMMENT ON COLUMN public.skill_learning_batch.outcome IS '提案、无新增、复用或已失效。';
COMMENT ON COLUMN public.skill_learning_batch.draft_id IS '同范围的可选草稿；无新增不创建。';
COMMENT ON COLUMN public.skill_learning_batch.dependency_ids IS '批次完整来源删除依赖。';
COMMENT ON COLUMN public.skill_learning_batch.created_at IS '批次完成时间。';
COMMENT ON TABLE public.skill_learning_receipt IS '材料不可重复消费的无正文回执；删除保留身份但清除内容摘要。';
COMMENT ON COLUMN public.skill_learning_receipt.owner_id IS '回执所属用户。';
COMMENT ON COLUMN public.skill_learning_receipt.contact_id IS '回执所属联系人。';
COMMENT ON COLUMN public.skill_learning_receipt.material_id IS '任务相关输入、修改或选择的稳定身份。';
COMMENT ON COLUMN public.skill_learning_receipt.digest IS '原材料摘要；来源删除时置空。';
COMMENT ON COLUMN public.skill_learning_receipt.batch_id IS '消费该材料的同范围批次。';
COMMENT ON TABLE public.skill_method_identity IS '用户内方法延续身份；只分配提案身份，不授予运行或发布权限。';
COMMENT ON COLUMN public.skill_method_identity.owner_id IS '方法所属用户。';
COMMENT ON COLUMN public.skill_method_identity.logical_skill_id IS '所属逻辑Skill身份。';
COMMENT ON COLUMN public.skill_method_identity.method_id IS '应用分配的稳定方法身份。';
COMMENT ON COLUMN public.skill_method_identity.semantic_key_sha256 IS '方法语义键摘要，避免同方法重复分配。';
COMMIT;
