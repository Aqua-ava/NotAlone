BEGIN;
-- 受理后保留原请求地址与空闲分段来源，同键重放不重新决定归属。
ALTER TABLE public.assistant_session
 ADD COLUMN idle_previous_session_id uuid REFERENCES public.assistant_session(id) ON DELETE SET NULL;
ALTER TABLE public.assistant_session_turn
 ADD COLUMN requested_session_id uuid REFERENCES public.assistant_session(id) ON DELETE SET NULL;
COMMIT;
