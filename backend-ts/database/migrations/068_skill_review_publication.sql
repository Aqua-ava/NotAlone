BEGIN;
ALTER TABLE public.reply_skill_version ADD COLUMN review_origin boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.reply_skill_version.review_origin IS '审核发布的不可混淆标记；缺少有效范围元数据时禁止读取，不能退化为独立导入包。';

ALTER TABLE public.skill_draft ADD COLUMN current_comparison_id uuid;
ALTER TABLE public.skill_draft ADD COLUMN last_decision text CHECK (last_decision IN ('defer','reject','approve'));
COMMENT ON COLUMN public.skill_draft.current_comparison_id IS '当前冻结审核对照；编辑或删除后清除。';
COMMENT ON COLUMN public.skill_draft.last_decision IS '用户最近明确决定；暂留仍为待审核状态。';

CREATE TABLE public.skill_review_comparison (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    draft_id uuid NOT NULL,
    draft_revision integer NOT NULL CHECK (draft_revision > 0),
    input_version uuid NOT NULL,
    input jsonb,
    confirmed_scope jsonb,
    context_fingerprint text,
    library_revision bigint NOT NULL,
    dependency_ids uuid[] NOT NULL DEFAULT '{}',
    source_generation jsonb NOT NULL DEFAULT '{}',
    target_versions jsonb NOT NULL DEFAULT '[]',
    state text NOT NULL CHECK (state IN ('running','completed','failed','invalidated')),
    run_token uuid,
    lease_expires_at timestamptz,
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(draft_id,owner_id,contact_id) REFERENCES public.skill_draft(id,owner_id,contact_id) ON DELETE CASCADE,
    UNIQUE(id,owner_id,contact_id),
    CHECK (state <> 'invalidated' OR (input IS NULL AND confirmed_scope IS NULL
        AND context_fingerprint IS NULL AND cardinality(dependency_ids)=0
        AND source_generation='{}' AND target_versions='[]' AND result IS NULL))
);
CREATE INDEX skill_review_comparison_dependencies ON public.skill_review_comparison USING gin(dependency_ids);

CREATE TABLE public.skill_review_operation (
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    draft_id uuid NOT NULL,
    operation_key uuid NOT NULL,
    action text NOT NULL CHECK (action IN ('edit','compare','approve','decision')),
    request_fingerprint text,
    comparison_id uuid REFERENCES public.skill_review_comparison(id),
    published_version_id uuid REFERENCES public.reply_skill_version(id),
    PRIMARY KEY(owner_id,contact_id,operation_key),
    FOREIGN KEY(draft_id,owner_id,contact_id) REFERENCES public.skill_draft(id,owner_id,contact_id) ON DELETE CASCADE
);

CREATE TABLE public.skill_review_call (
    comparison_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    side text NOT NULL CHECK (side IN ('before','after')),
    ledger_entry_id uuid NOT NULL REFERENCES public.outbound_ledger_entry(id),
    PRIMARY KEY(comparison_id,ledger_entry_id),
    FOREIGN KEY(comparison_id,owner_id,contact_id) REFERENCES public.skill_review_comparison(id,owner_id,contact_id) ON DELETE CASCADE
);
COMMENT ON TABLE public.skill_review_call IS '显式审核模型用途与旧版或草稿侧的最小出站台账关联，不含输入正文。';
COMMENT ON COLUMN public.skill_review_call.comparison_id IS '冻结对照身份。';
COMMENT ON COLUMN public.skill_review_call.owner_id IS '调用所属用户。';
COMMENT ON COLUMN public.skill_review_call.contact_id IS '调用所属联系人。';
COMMENT ON COLUMN public.skill_review_call.side IS '旧版或草稿的只读试用用途。';
COMMENT ON COLUMN public.skill_review_call.ledger_entry_id IS '不含正文的供应商调用台账。';

CREATE TABLE public.reply_skill_publication (
    version_id uuid PRIMARY KEY REFERENCES public.reply_skill_version(id) ON DELETE CASCADE,
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    origin_contact_id uuid NOT NULL,
    draft_id uuid NOT NULL,
    logical_skill_id uuid NOT NULL,
    scope_kind text NOT NULL CHECK (scope_kind IN ('owner','contact','scene')),
    scope_contact_id uuid,
    scene text,
    dependency_ids uuid[] NOT NULL DEFAULT '{}',
    source_generation jsonb NOT NULL DEFAULT '{}',
    deleted boolean NOT NULL DEFAULT false,
    FOREIGN KEY(draft_id,owner_id,origin_contact_id) REFERENCES public.skill_draft(id,owner_id,contact_id) ON DELETE CASCADE,
    CHECK ((scope_kind='contact' AND scope_contact_id IS NOT NULL AND scope_contact_id=origin_contact_id AND scene IS NULL)
        OR (scope_kind='owner' AND scope_contact_id IS NULL AND scene IS NULL)
        OR (scope_kind='scene' AND scope_contact_id IS NULL AND scene IS NOT NULL AND length(btrim(scene))>0))
);
CREATE INDEX reply_skill_publication_dependencies ON public.reply_skill_publication USING gin(dependency_ids);

CREATE TABLE public.reply_skill_method (
    version_id uuid NOT NULL REFERENCES public.reply_skill_publication(version_id) ON DELETE CASCADE,
    method_id uuid NOT NULL,
    logical_skill_id uuid NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 5),
    title text,
    instruction text,
    replaces_method_ids uuid[] NOT NULL DEFAULT '{}',
    mapping_state text NOT NULL CHECK (mapping_state IN ('new','confirmed','unmapped')),
    PRIMARY KEY(version_id,method_id),
    UNIQUE(version_id,ordinal)
);

COMMENT ON TABLE public.skill_review_comparison IS '独立只读审核对照；冻结输入及两侧结果继承完整来源删除依赖。';
COMMENT ON COLUMN public.skill_review_comparison.id IS '审核对照身份。';
COMMENT ON COLUMN public.skill_review_comparison.owner_id IS '已验证用户。';
COMMENT ON COLUMN public.skill_review_comparison.contact_id IS '私人审核材料所属联系人。';
COMMENT ON COLUMN public.skill_review_comparison.draft_id IS '同范围草稿身份。';
COMMENT ON COLUMN public.skill_review_comparison.draft_revision IS '对照冻结的草稿修订。';
COMMENT ON COLUMN public.skill_review_comparison.input_version IS '用户显式审核输入版本；不证明外部消息发生。';
COMMENT ON COLUMN public.skill_review_comparison.input IS '含正文的审核输入，来源删除时清除。';
COMMENT ON COLUMN public.skill_review_comparison.confirmed_scope IS '本次预览明确声明的发布范围。';
COMMENT ON COLUMN public.skill_review_comparison.context_fingerprint IS '真实回复上下文的冻结身份摘要。';
COMMENT ON COLUMN public.skill_review_comparison.library_revision IS '对照冻结的目录修订。';
COMMENT ON COLUMN public.skill_review_comparison.dependency_ids IS '全部参与资料的删除依赖。';
COMMENT ON COLUMN public.skill_review_comparison.source_generation IS '冻结的来源代际与上下文修订。';
COMMENT ON COLUMN public.skill_review_comparison.target_versions IS '更新或合并的冻结目标版本。';
COMMENT ON COLUMN public.skill_review_comparison.state IS '运行、完成、失败或已清空。';
COMMENT ON COLUMN public.skill_review_comparison.run_token IS '单次模型尝试的栅栏身份，阻止迟到覆盖。';
COMMENT ON COLUMN public.skill_review_comparison.lease_expires_at IS '崩溃后允许同一操作恢复的租约期限。';
COMMENT ON COLUMN public.skill_review_comparison.result IS '同一输入生成的旧版或无策略与草稿候选。';
COMMENT ON COLUMN public.skill_review_comparison.created_at IS '首次冻结输入时间。';
COMMENT ON TABLE public.skill_review_operation IS '审核动作的无正文幂等回执；删除时清除内容摘要。';
COMMENT ON COLUMN public.skill_review_operation.owner_id IS '已验证用户。';
COMMENT ON COLUMN public.skill_review_operation.contact_id IS '操作所属联系人。';
COMMENT ON COLUMN public.skill_review_operation.draft_id IS '同范围草稿身份。';
COMMENT ON COLUMN public.skill_review_operation.operation_key IS '用户动作稳定重试身份。';
COMMENT ON COLUMN public.skill_review_operation.action IS '明确管理动作，模型不可调用。';
COMMENT ON COLUMN public.skill_review_operation.request_fingerprint IS '原动作摘要；不能复用批准新正文，删除后置空。';
COMMENT ON COLUMN public.skill_review_operation.comparison_id IS '可选冻结对照身份。';
COMMENT ON COLUMN public.skill_review_operation.published_version_id IS '批准已提交的唯一不可变版本身份。';
COMMENT ON TABLE public.reply_skill_publication IS '用户批准的不可变版本范围与完整取材依赖；私人审核内容不在此表。';
COMMENT ON COLUMN public.reply_skill_publication.version_id IS '不可变发布版本。';
COMMENT ON COLUMN public.reply_skill_publication.owner_id IS '版本所属用户。';
COMMENT ON COLUMN public.reply_skill_publication.origin_contact_id IS '取材联系人；广范围使用不改变删除依赖。';
COMMENT ON COLUMN public.reply_skill_publication.draft_id IS '经审核草稿身份。';
COMMENT ON COLUMN public.reply_skill_publication.logical_skill_id IS '稳定逻辑Skill身份，供方法政策延续。';
COMMENT ON COLUMN public.reply_skill_publication.scope_kind IS '用户明确批准的通用、联系人或场景范围。';
COMMENT ON COLUMN public.reply_skill_publication.scope_contact_id IS '联系人范围的已确认目标。';
COMMENT ON COLUMN public.reply_skill_publication.scene IS '必须逐字匹配的显式场景；不由模型猜测。';
COMMENT ON COLUMN public.reply_skill_publication.dependency_ids IS '全部学习来源与审核输入依赖。';
COMMENT ON COLUMN public.reply_skill_publication.source_generation IS '发布时仍有效的原始来源代际。';
COMMENT ON COLUMN public.reply_skill_publication.deleted IS '先禁止读取，再清除正文和派生副本。';
COMMENT ON TABLE public.reply_skill_method IS '发布方法与延续映射；停用政策独立于不可变正文，未知映射保守处理。';
COMMENT ON COLUMN public.reply_skill_method.version_id IS '所属不可变版本。';
COMMENT ON COLUMN public.reply_skill_method.method_id IS '稳定方法身份。';
COMMENT ON COLUMN public.reply_skill_method.logical_skill_id IS '方法所属逻辑Skill身份。';
COMMENT ON COLUMN public.reply_skill_method.ordinal IS '原版本方法顺序，供受控执行视图裁剪。';
COMMENT ON COLUMN public.reply_skill_method.title IS '审核后的方法标题，删除时清除。';
COMMENT ON COLUMN public.reply_skill_method.instruction IS '审核后的方法正文，删除时清除。';
COMMENT ON COLUMN public.reply_skill_method.replaces_method_ids IS '明确审核的前代方法身份；改名不解除范围停用。';
COMMENT ON COLUMN public.reply_skill_method.mapping_state IS '新建、用户确认延续或无法映射；未知不得当作全新方法。';
COMMIT;
