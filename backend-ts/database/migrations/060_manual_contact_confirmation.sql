BEGIN;

CREATE TABLE public.manual_contact_confirmation (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    confirmed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_id, contact_id),
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE public.manual_contact_confirmation IS
    '用户显式选择的手动输入联系人范围；不是微信身份、桌面会话绑定或读取授权。';
COMMENT ON COLUMN public.manual_contact_confirmation.id IS
    '回复协议兼容字段 conversation_binding_id 使用的内部执行隔离标识，不引用外部会话。';

-- 与 src/notalone/reply/context.py 的 EVIDENCE_KINDS 保持一致。
ALTER TABLE public.reply_context_evidence DROP CONSTRAINT reply_context_evidence_kind_check;
ALTER TABLE public.reply_context_evidence ADD CONSTRAINT reply_context_evidence_kind_check
    CHECK (kind IN ('message', 'confirmed_memory', 'owner_memory', 'user_draft',
                   'user_current_chat', 'user_purpose', 'continued_candidate', 'pending_candidate'));

ALTER TABLE public.assistant_session_turn DROP CONSTRAINT assistant_session_turn_interruption_reason_check;
ALTER TABLE public.assistant_session_turn ADD CONSTRAINT assistant_session_turn_interruption_reason_check
    CHECK (interruption_reason IS NULL OR
           (interruption_reason IN ('app_quit', 'configuration_reload') AND state IN ('failed', 'redacted')));
COMMENT ON COLUMN public.assistant_session_turn.interruption_reason IS
    '无正文中断来历：app_quit为退出App，configuration_reload为设置或资料更新前结束原运行时；旧键失效，仅用户显式新请求可恢复。';

COMMIT;
