BEGIN;
-- 先独立持久化已验证目录身份，避免部分清盘移除marker后丢失安全重试依据；不保存正文或路径。
ALTER TABLE public.assistant_runtime_deletion_target
 ADD COLUMN directory_identity jsonb
 CHECK(directory_identity IS NULL OR jsonb_typeof(directory_identity)='object');
COMMENT ON COLUMN public.assistant_runtime_deletion_target.directory_identity IS
 '仅进行中/失败删除的同操作目录身份；完成后随target删除，不用于恢复或生成授权。';
COMMIT;
