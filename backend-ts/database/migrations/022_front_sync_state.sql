BEGIN;

-- 前台同步开关状态：用户手动开启/关闭前台增量同步的持久化记录。
-- 应用重启后从这里判断同步是否仍然开启；最近一次关闭与开启的时间戳
-- 共同确定手动关闭期间的消息窗口，重新开启后对任何联系人读到的
-- 该窗口内消息都只前移水位、不写入。
-- 迁移保持幂等：重复执行不会报错，也不会改变已有数据。
CREATE TABLE IF NOT EXISTS public.front_sync_state (
    owner_id uuid PRIMARY KEY
        REFERENCES public.owner(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT false,
    enabled_at timestamptz,
    disabled_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.front_sync_state IS
    '前台增量同步的开关状态；只能由用户手动开启或关闭。';
COMMENT ON COLUMN public.front_sync_state.enabled IS
    '用户是否开启了前台同步；应用异常重启后仍开启时从联系人水位恢复读取。';
COMMENT ON COLUMN public.front_sync_state.enabled_at IS
    '最近一次手动开启同步的时间；与 disabled_at 共同界定不补读的关闭窗口。';
COMMENT ON COLUMN public.front_sync_state.disabled_at IS
    '最近一次手动关闭同步的时间；关闭之后、再次开启之前产生的消息不被写入。';
COMMENT ON COLUMN public.front_sync_state.updated_at IS
    '最近一次开关状态变化的时间。';

COMMIT;
