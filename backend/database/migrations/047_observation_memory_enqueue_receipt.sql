BEGIN;

-- 回执与来源共生；同批消息事件不重复重排，来源删除后旧通知无法恢复它。
ALTER TABLE public.local_wechat_observation
    ADD COLUMN memory_enqueued_at timestamptz;

COMMENT ON COLUMN public.local_wechat_observation.memory_enqueued_at IS
    '该观察批次首次可靠排队记忆任务的时间，不含正文；与任务排队同事务提交。';

COMMIT;
