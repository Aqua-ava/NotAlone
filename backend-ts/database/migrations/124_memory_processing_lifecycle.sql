BEGIN;
-- 范围控制意图与轮次身份分开保存；不回填旧任务，不把旧停止猜成用户暂停。
CREATE TABLE public.memory_processing_scope (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
 contact_id uuid,
 scope_kind text GENERATED ALWAYS AS (CASE WHEN contact_id IS NULL THEN 'owner' ELSE 'contact' END) STORED NOT NULL,
 scope_key uuid GENERATED ALWAYS AS (COALESCE(contact_id,owner_id)) STORED NOT NULL,
 control_generation bigint NOT NULL DEFAULT 0 CHECK(control_generation>=0),
 intent text NOT NULL DEFAULT 'run' CHECK(intent IN ('run','pause')),
 active_round_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE,
 UNIQUE(owner_id,scope_kind,scope_key),
 UNIQUE(id,owner_id,scope_kind,scope_key)
);
CREATE TABLE public.memory_processing_round (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 scope_id uuid NOT NULL,
 owner_id uuid NOT NULL,
 contact_id uuid,
 scope_kind text GENERATED ALWAYS AS (CASE WHEN contact_id IS NULL THEN 'owner' ELSE 'contact' END) STORED NOT NULL,
 scope_key uuid GENERATED ALWAYS AS (COALESCE(contact_id,owner_id)) STORED NOT NULL,
 round_number bigint NOT NULL CHECK(round_number>0),
 control_generation bigint NOT NULL CHECK(control_generation>=0),
 status text NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','processing','completed','blocked')),
 phase text CHECK(phase IN ('extraction','verification','topics','profile','retry')),
 target_unit text CHECK(target_unit IN ('messages','memories','steps')),
 target_count bigint CHECK(target_count>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 FOREIGN KEY(scope_id,owner_id,scope_kind,scope_key) REFERENCES public.memory_processing_scope(id,owner_id,scope_kind,scope_key) ON DELETE CASCADE,
 UNIQUE(scope_id,round_number),
 UNIQUE(id,scope_id),
 UNIQUE(id,owner_id,scope_kind,scope_key)
);
ALTER TABLE public.memory_processing_scope ADD CONSTRAINT memory_processing_active_round_scope
 FOREIGN KEY(active_round_id,id) REFERENCES public.memory_processing_round(id,scope_id) DEFERRABLE INITIALLY DEFERRED;
-- 同一真实任务允许留下历史归属；同一时刻只能有一个有效轮次拥有它。
CREATE TABLE public.memory_processing_round_task (
 round_id uuid NOT NULL,
 task_id uuid NOT NULL,
 owner_id uuid NOT NULL,
 contact_id uuid,
 scope_kind text GENERATED ALWAYS AS (CASE WHEN contact_id IS NULL THEN 'owner' ELSE 'contact' END) STORED NOT NULL,
 scope_key uuid GENERATED ALWAYS AS (COALESCE(contact_id,owner_id)) STORED NOT NULL,
 active boolean NOT NULL DEFAULT true,
 PRIMARY KEY(round_id,task_id),
 FOREIGN KEY(round_id,owner_id,scope_kind,scope_key) REFERENCES public.memory_processing_round(id,owner_id,scope_kind,scope_key) ON DELETE CASCADE,
 FOREIGN KEY(task_id,owner_id,scope_kind) REFERENCES public.background_task(id,owner_id,scope_kind) ON DELETE CASCADE,
 FOREIGN KEY(task_id,owner_id,contact_id) REFERENCES public.background_task(id,owner_id,contact_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX memory_processing_task_active_round ON public.memory_processing_round_task(task_id) WHERE active;
CREATE FUNCTION public.check_memory_processing_task_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.background_task t WHERE t.id=NEW.task_id AND t.owner_id=NEW.owner_id
   AND t.contact_id IS NOT DISTINCT FROM NEW.contact_id AND t.task_type IN ('import','observation','layered_memory')) THEN
  RAISE EXCEPTION 'memory_processing_task_scope_mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER memory_processing_task_scope BEFORE INSERT OR UPDATE ON public.memory_processing_round_task
 FOR EACH ROW EXECUTE FUNCTION public.check_memory_processing_task_scope();
COMMIT;
