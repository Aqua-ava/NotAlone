BEGIN;

-- 历史同步授权版本：只有用户明确同意读取既有文字历史后才写入 accepted。
-- 老授权没有行，读取端必须解释为“待确认”，不能按同步范围或总开关推断。
CREATE TABLE IF NOT EXISTS public.wechat_history_sync_authorization (
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    channel text NOT NULL CHECK (channel = 'wechat'),
    account_scope text NOT NULL CHECK (length(btrim(account_scope)) > 0),
    version integer NOT NULL CHECK (version > 0),
    decision text NOT NULL CHECK (decision IN ('accepted', 'declined')),
    decided_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, channel, account_scope)
);

COMMENT ON TABLE public.wechat_history_sync_authorization IS
    '用户对历史同步授权版本的明确决定；行不存在表示旧授权，尚未授予历史读取资格。';
COMMENT ON COLUMN public.wechat_history_sync_authorization.version IS
    '用户确认时展示的历史读取授权版本；低于当前版本需要重新确认。';
COMMENT ON COLUMN public.wechat_history_sync_authorization.decision IS
    'accepted 或 declined；已同意后迟到的拒绝不能静默收回资格。';

COMMIT;
