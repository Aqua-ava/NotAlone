BEGIN;

-- 样本不外键依赖候选或助手会话：ADR-044要求先成功主动保存者独立留存。
CREATE TABLE public.style_sample (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    save_key uuid NOT NULL,
    final_text text CHECK (length(btrim(final_text)) BETWEEN 1 AND 4096),
    origin_kind text NOT NULL CHECK (origin_kind IN ('manual','candidate','message')),
    origin_id uuid,
    source_ids uuid[] NOT NULL DEFAULT '{}',
    dependency_sample_ids uuid[] NOT NULL DEFAULT '{}',
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
    sending_status text NOT NULL DEFAULT 'unknown' CHECK (sending_status = 'unknown'),
    saved_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    FOREIGN KEY (owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE,
    UNIQUE(owner_id,contact_id,save_key),
    UNIQUE(id,owner_id,contact_id),
    CHECK ((origin_kind = 'manual' AND origin_id IS NULL) OR (origin_kind <> 'manual' AND origin_id IS NOT NULL)),
    CHECK ((status = 'active' AND final_text IS NOT NULL AND deleted_at IS NULL) OR (status = 'deleted' AND final_text IS NULL AND deleted_at IS NOT NULL))
);
CREATE INDEX style_sample_contact_idx ON public.style_sample(owner_id,contact_id,saved_at DESC,id);
CREATE INDEX style_sample_sources_idx ON public.style_sample USING gin(source_ids);
CREATE INDEX style_sample_dependencies_idx ON public.style_sample USING gin(dependency_sample_ids);

-- 仅记录实际生成使用，不参加方向探索；删除样本清理依赖请求的正文副本。
CREATE TABLE public.reply_style_sample_use (
    reply_request_id uuid NOT NULL REFERENCES public.reply_request(id) ON DELETE CASCADE,
    sample_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    PRIMARY KEY(reply_request_id,sample_id),
    FOREIGN KEY(sample_id,owner_id,contact_id) REFERENCES public.style_sample(id,owner_id,contact_id),
    FOREIGN KEY(owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE
);
-- 生成提交时实际采用的原始资料标识；不能事后把新增消息来源当作过去的来源。
CREATE TABLE public.reply_original_source_use (
    reply_request_id uuid NOT NULL REFERENCES public.reply_request(id) ON DELETE CASCADE,
    source_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    PRIMARY KEY(reply_request_id,source_id),
    FOREIGN KEY(owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE
);
CREATE INDEX reply_original_source_owner_idx ON public.reply_original_source_use(owner_id,source_id);
CREATE TABLE public.reply_invalidated_key (
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    idempotency_key uuid NOT NULL,
    invalidated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(owner_id,contact_id,idempotency_key),
    FOREIGN KEY(owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE
);
COMMENT ON TABLE public.style_sample IS '用户主动保存、可单独删除的联系人表达参考；不证明发送，不保存助手讨论全文。';
COMMENT ON TABLE public.reply_style_sample_use IS '本次候选生成实际选择的样本标识；没有事实引用语义。';
COMMENT ON TABLE public.reply_original_source_use IS '候选实际使用的原始来源标识，含记忆所引用消息的原始来源；不复制正文。';
COMMENT ON TABLE public.reply_invalidated_key IS '已删除派生回复的无正文请求键凭证，防止同键重新生成伪装恢复。';

COMMIT;
