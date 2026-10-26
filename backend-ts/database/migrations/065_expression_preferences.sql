BEGIN;

-- 独立于记忆、样本和Skill的明确用户决定，不从生成或复制动作自动写入。
CREATE TABLE public.expression_preference_state (
    owner_id uuid PRIMARY KEY REFERENCES public.owner(id) ON DELETE CASCADE,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
CREATE TABLE public.expression_preference (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    contact_id uuid,
    reply_mode text CHECK (reply_mode IN ('reply_to_message','rewrite_draft','initiate_conversation')),
    text_content text CHECK (length(btrim(text_content)) BETWEEN 1 AND 512),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    confirmed_operation_key uuid NOT NULL,
    origin_kind text CHECK (origin_kind IN ('manual','message')),
    origin_id uuid,
    source_ids uuid[] NOT NULL DEFAULT '{}',
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
    confirmed_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    UNIQUE(id,owner_id),
    FOREIGN KEY(owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE RESTRICT,
    CHECK ((status='active' AND text_content IS NOT NULL AND deleted_at IS NULL AND (
        (origin_kind='manual' AND origin_id IS NULL AND cardinality(source_ids)=0)
        OR (origin_kind='message' AND origin_id IS NOT NULL AND contact_id IS NOT NULL AND cardinality(source_ids)>0)
    )) OR (status='deleted' AND text_content IS NULL AND origin_kind IS NULL AND origin_id IS NULL
        AND cardinality(source_ids)=0 AND deleted_at IS NOT NULL))
);
CREATE INDEX expression_preference_scope_idx ON public.expression_preference(owner_id,contact_id,reply_mode);
CREATE INDEX expression_preference_sources_idx ON public.expression_preference USING gin(source_ids);

-- 只保留操作身份、种类与版本；删除偏好时清除摘要，不保存原始用户正文。
CREATE TABLE public.expression_preference_operation (
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    operation_key uuid NOT NULL,
    preference_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('save','update','delete')),
    input_digest text CHECK (input_digest ~ '^[0-9a-f]{64}$'),
    result_revision bigint NOT NULL CHECK (result_revision >= 1),
    confirmed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(owner_id,operation_key),
    FOREIGN KEY(preference_id,owner_id) REFERENCES public.expression_preference(id,owner_id) ON DELETE CASCADE
);

ALTER TABLE public.reply_request ADD COLUMN expression_preference_revision bigint
    CHECK (expression_preference_revision >= 0);
CREATE TABLE public.reply_expression_preference_use (
    reply_request_id uuid NOT NULL REFERENCES public.reply_request(id) ON DELETE CASCADE,
    preference_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    preference_revision bigint NOT NULL CHECK (preference_revision >= 1),
    PRIMARY KEY(reply_request_id,preference_id),
    FOREIGN KEY(preference_id,owner_id) REFERENCES public.expression_preference(id,owner_id),
    FOREIGN KEY(owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE
);
CREATE INDEX reply_expression_preference_use_idx ON public.reply_expression_preference_use(owner_id,preference_id);

-- 样本独立留存只保留已验证的偏好版本身份；不依赖会话或候选仍然存在。
CREATE TABLE public.style_sample_expression_preference_use (
    sample_id uuid NOT NULL,
    preference_id uuid NOT NULL,
    preference_revision bigint NOT NULL CHECK (preference_revision >= 1),
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    PRIMARY KEY(sample_id,preference_id,preference_revision),
    FOREIGN KEY(sample_id,owner_id,contact_id) REFERENCES public.style_sample(id,owner_id,contact_id) ON DELETE CASCADE,
    FOREIGN KEY(preference_id,owner_id) REFERENCES public.expression_preference(id,owner_id)
);
CREATE INDEX style_sample_expression_preference_use_idx ON public.style_sample_expression_preference_use(owner_id,preference_id);

COMMENT ON TABLE public.expression_preference IS '用户明确长期保存的表达要求；当前意图优先，输入模式范围不等于沟通场景。';
COMMENT ON TABLE public.expression_preference_operation IS '认证宿主接收的明确用户操作与幂等版本；删除后不留可恢复正文摘要。';
COMMENT ON TABLE public.reply_expression_preference_use IS '模型前实际选择的偏好版本，提交、删除和恢复沿此依赖复验。';
COMMENT ON TABLE public.style_sample_expression_preference_use IS '主动候选样本的独立偏好依赖；会话删除保留身份，偏好删除仍清样本。';

COMMENT ON TABLE public.expression_preference_state IS '用户明确偏好集合的单调修订；不包含正文。';
COMMENT ON COLUMN public.expression_preference_state.owner_id IS '偏好集合所属用户的隔离键；用户删除时级联清除。';
COMMENT ON COLUMN public.expression_preference_state.revision IS '该用户明确偏好集合的单调修订；不表示偏好条数。';
COMMENT ON COLUMN public.expression_preference.id IS '稳定偏好身份；删除后仅保留无正文墓碑以拒绝旧操作重放。';
COMMENT ON COLUMN public.expression_preference.owner_id IS '明确偏好所属用户的隔离键。';
COMMENT ON COLUMN public.expression_preference.contact_id IS '联系人范围；NULL表示本人全局表达要求。物理删除联系人须先事务清理偏好及完整派生闭包。';
COMMENT ON COLUMN public.expression_preference.reply_mode IS '输入模式范围；NULL表示全部模式，不代表沟通场景。';
COMMENT ON COLUMN public.expression_preference.text_content IS '用户明确长期保存的表达要求；删除后置空。';
COMMENT ON COLUMN public.expression_preference.revision IS '该条偏好的单调修订，用于防止旧版本覆盖。';
COMMENT ON COLUMN public.expression_preference.confirmed_operation_key IS '最近一次明确用户保存或更新操作的幂等身份。';
COMMENT ON COLUMN public.expression_preference.origin_kind IS '独立手录或已确认联系人消息来源；删除后置空。';
COMMENT ON COLUMN public.expression_preference.origin_id IS '消息来源的稳定身份；手录及删除后为空。';
COMMENT ON COLUMN public.expression_preference.source_ids IS '参与偏好的完整原始来源依赖；删除后清空。';
COMMENT ON COLUMN public.expression_preference.status IS '活动或已删除墓碑；已删除状态不得恢复旧正文。';
COMMENT ON COLUMN public.expression_preference.confirmed_at IS '用户首次明确长期保存的时间；不是来源发生时间。';
COMMENT ON COLUMN public.expression_preference.updated_at IS '最近一次偏好修订的事务时间。';
COMMENT ON COLUMN public.expression_preference.deleted_at IS '正文可靠清除的事务时间；活动记录为空。';
COMMENT ON COLUMN public.expression_preference_operation.owner_id IS '操作所属用户的隔离键。';
COMMENT ON COLUMN public.expression_preference_operation.operation_key IS '用户明确操作的幂等身份。';
COMMENT ON COLUMN public.expression_preference_operation.preference_id IS '该操作涉及的稳定偏好身份。';
COMMENT ON COLUMN public.expression_preference_operation.kind IS '保存、更新或删除操作种类。';
COMMENT ON COLUMN public.expression_preference_operation.input_digest IS '幂等输入摘要；删除偏好时清除，不能恢复正文。';
COMMENT ON COLUMN public.expression_preference_operation.result_revision IS '操作成功后的偏好修订。';
COMMENT ON COLUMN public.expression_preference_operation.confirmed_at IS '认证宿主接收明确操作的事务时间。';
COMMENT ON COLUMN public.reply_request.expression_preference_revision IS '该请求模型前捕获的偏好集合修订；旧请求NULL保持未知。';
COMMENT ON COLUMN public.reply_expression_preference_use.reply_request_id IS '实际使用偏好的请求；请求清除时级联清除此依赖。';
COMMENT ON COLUMN public.reply_expression_preference_use.preference_id IS '模型前实际选中的稳定偏好身份。';
COMMENT ON COLUMN public.reply_expression_preference_use.owner_id IS '使用回执所属用户的隔离键。';
COMMENT ON COLUMN public.reply_expression_preference_use.contact_id IS '生成请求所属的已确认联系人。';
COMMENT ON COLUMN public.reply_expression_preference_use.preference_revision IS '生成时实际使用的偏好版本；不回填当前版本。';
COMMENT ON COLUMN public.style_sample_expression_preference_use.sample_id IS '用户主动保留的候选样本；样本删除时级联清除。';
COMMENT ON COLUMN public.style_sample_expression_preference_use.preference_id IS '样本生成时参与的稳定偏好身份。';
COMMENT ON COLUMN public.style_sample_expression_preference_use.preference_revision IS '样本生成时实际使用的偏好版本。';
COMMENT ON COLUMN public.style_sample_expression_preference_use.owner_id IS '样本偏好依赖所属用户的隔离键。';
COMMENT ON COLUMN public.style_sample_expression_preference_use.contact_id IS '样本所属的已确认联系人。';

COMMIT;
