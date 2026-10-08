BEGIN;

-- 本地微信 CLI 增量观察：来源记录与按联系人独立的 cursor 水位。
-- 只保存一次只读读取的元数据（CLI 版本、读取时间、水位区间、模式、
-- 外部消息数量），不保存全量导出、截图或消息正文副本。
-- 迁移保持幂等：重复执行不会报错，也不会改变已有数据。
CREATE TABLE IF NOT EXISTS public.local_wechat_observation (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    binding_id uuid NOT NULL,
    mode text NOT NULL CHECK (mode IN ('live', 'cli_catchup')),
    cli_version text NOT NULL CHECK (length(btrim(cli_version)) > 0),
    conversation_locator text NOT NULL
        CHECK (length(btrim(conversation_locator)) > 0),
    read_at timestamptz NOT NULL DEFAULT now(),
    since_local_id bigint,
    last_local_id bigint NOT NULL CHECK (last_local_id > 0),
    since_cursor text,
    last_cursor text NOT NULL CHECK (length(btrim(last_cursor)) > 0),
    record_count integer NOT NULL CHECK (record_count >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE,
    FOREIGN KEY (binding_id)
        REFERENCES public.conversation_binding(id) ON DELETE CASCADE,
    CHECK (
        since_local_id IS NULL
        OR (since_local_id > 0 AND since_local_id <= last_local_id)
    )
);

CREATE INDEX IF NOT EXISTS local_wechat_observation_scope_idx
    ON public.local_wechat_observation (owner_id, contact_id, read_at DESC);

-- 同一绑定、同一模式、同一水位区间的重复读取只保留一条来源，
-- 保证批次重试不会重复创建来源记录。
CREATE UNIQUE INDEX IF NOT EXISTS local_wechat_observation_batch_unique
    ON public.local_wechat_observation (
        owner_id,
        contact_id,
        binding_id,
        mode,
        COALESCE(since_local_id, 0),
        last_local_id
    );

COMMENT ON TABLE public.local_wechat_observation IS
    '一次本地微信 CLI 只读增量读取的来源元数据；不保存全量导出或消息正文。';
COMMENT ON COLUMN public.local_wechat_observation.binding_id IS
    '产生该观察的已确认会话绑定；绑定行删除时按来源级删除路径级联清理。';
COMMENT ON COLUMN public.local_wechat_observation.mode IS
    '观察模式：live 为前台实时读取，cli_catchup 为切回联系人后的补读。';
COMMENT ON COLUMN public.local_wechat_observation.cli_version IS
    '读取时使用的 wechat-cli 版本标识；只保存版本字符串。';
COMMENT ON COLUMN public.local_wechat_observation.conversation_locator IS
    '读取会话的外部稳定定位符；不是昵称，也不是聊天正文。';
COMMENT ON COLUMN public.local_wechat_observation.read_at IS
    'CLI 增量读取完成的时间。';
COMMENT ON COLUMN public.local_wechat_observation.since_local_id IS
    '本次读取使用的起始外部 local_id；首次读取为空，不允许使用 0。';
COMMENT ON COLUMN public.local_wechat_observation.last_local_id IS
    '本次读取成功返回的最大外部 local_id；只有成功返回的水位才可保存。';
COMMENT ON COLUMN public.local_wechat_observation.since_cursor IS
    '本次读取使用的续传 cursor 文本；首次读取为空。';
COMMENT ON COLUMN public.local_wechat_observation.last_cursor IS
    'CLI 成功返回的续传 cursor；后续增量读取只能使用成功返回的 cursor。';
COMMENT ON COLUMN public.local_wechat_observation.record_count IS
    '本次读取返回的消息事件数量；只保存计数，不保存正文。';

CREATE TABLE IF NOT EXISTS public.wechat_observation_cursor (
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    binding_id uuid NOT NULL,
    conversation_locator text NOT NULL
        CHECK (length(btrim(conversation_locator)) > 0),
    last_local_id bigint NOT NULL CHECK (last_local_id > 0),
    last_cursor text NOT NULL CHECK (length(btrim(last_cursor)) > 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, contact_id),
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE,
    FOREIGN KEY (binding_id)
        REFERENCES public.conversation_binding(id) ON DELETE CASCADE
);

COMMENT ON TABLE public.wechat_observation_cursor IS
    '每个联系人独立的 CLI 观察水位；进程重启后从这里恢复增量读取位置。';
COMMENT ON COLUMN public.wechat_observation_cursor.last_local_id IS
    '该联系人最近一次成功读取返回的最大外部 local_id；必须大于 0。';
COMMENT ON COLUMN public.wechat_observation_cursor.last_cursor IS
    '该联系人最近一次成功读取返回的续传 cursor；不使用非法的 0 起始值。';

COMMIT;
