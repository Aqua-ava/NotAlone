BEGIN;
ALTER TABLE public.assistant_session ADD COLUMN last_user_activity_at timestamptz;
COMMENT ON COLUMN public.assistant_session.last_user_activity_at IS
    '真实用户生成、补充、修改、明确继续或新开的活动时间；旧记录未知，不从通用更新时间推算。';
COMMIT;
