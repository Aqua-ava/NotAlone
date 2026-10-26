BEGIN;
-- 仅运行副本关联及提交状态；可见输入、候选与来源继续由原业务表裁定。
CREATE TABLE public.assistant_runtime_session (
 owner_id uuid NOT NULL,
 contact_id uuid NOT NULL,
 session_id uuid NOT NULL,
 runtime_session_id uuid NOT NULL UNIQUE,
 configuration_sha256 text NOT NULL CHECK(configuration_sha256 ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('ready','dirty','blocked')),
 committed_request_id uuid,
 committed_event_count integer NOT NULL DEFAULT 0 CHECK(committed_event_count>=0),
 PRIMARY KEY(owner_id,contact_id,session_id),
 FOREIGN KEY(session_id,owner_id,contact_id) REFERENCES public.assistant_session(id,owner_id,contact_id) ON DELETE CASCADE,
 FOREIGN KEY(committed_request_id) REFERENCES public.reply_request(id) ON DELETE SET NULL
);
COMMENT ON TABLE public.assistant_runtime_session IS '受管 DSH 运行副本关联；dirty 不能恢复为已提交历史，删除须先清理文件。';
COMMIT;
