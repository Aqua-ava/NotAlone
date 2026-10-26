BEGIN;
-- 只标记升级前已有讨论的来源，不读取、转换或复制输入与候选正文。
ALTER TABLE public.assistant_session ADD COLUMN legacy_runtime_pending boolean NOT NULL DEFAULT true;
UPDATE public.assistant_session session SET legacy_runtime_pending=false
 WHERE NOT EXISTS(SELECT 1 FROM public.assistant_session_input input WHERE input.owner_id=session.owner_id AND input.contact_id=session.contact_id AND input.session_id=session.id)
 AND NOT EXISTS(SELECT 1 FROM public.assistant_session_turn turn WHERE turn.owner_id=session.owner_id AND turn.contact_id=session.contact_id AND turn.session_id=session.id);
ALTER TABLE public.assistant_session ALTER COLUMN legacy_runtime_pending SET DEFAULT false;
COMMENT ON COLUMN public.assistant_session.legacy_runtime_pending IS '升级前既有讨论尚待首次明确继续；合格运行档案仍可续用，成功建档后解除。';
COMMIT;
