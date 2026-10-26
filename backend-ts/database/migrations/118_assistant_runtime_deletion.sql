BEGIN;
-- 清理目标不依赖会被业务级联删除的会话或运行映射；失败及重启保留同一操作身份。
CREATE TABLE public.assistant_runtime_deletion_target (
 operation_id uuid NOT NULL REFERENCES public.cross_domain_deletion_operation(id),
 owner_id uuid NOT NULL,
 contact_id uuid NOT NULL,
 session_id uuid NOT NULL,
 cleaned boolean NOT NULL DEFAULT false,
 PRIMARY KEY(operation_id,owner_id,contact_id,session_id)
);
CREATE INDEX assistant_runtime_deletion_scope ON public.assistant_runtime_deletion_target(owner_id,contact_id,session_id);
COMMIT;
