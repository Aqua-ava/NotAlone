-- 逐项核验的记忆整理默认维护；用户明确停用、删除和失败/暂停预算保持原决定。
ALTER TABLE public.layered_memory_state ALTER COLUMN enabled SET DEFAULT true;
ALTER TABLE public.layered_memory_state ALTER COLUMN status SET DEFAULT 'stale';
ALTER TABLE public.layered_memory_state ALTER COLUMN maintenance_allowed SET DEFAULT true;

CREATE OR REPLACE FUNCTION public.mark_layered_memory_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb;
BEGIN
    IF TG_OP='UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
    row_data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
    -- 删除不新建目标，避免联系人或账户级联删除时重新创建范围。
    IF TG_OP <> 'DELETE' THEN
        INSERT INTO public.layered_memory_state(owner_id,contact_id)
            VALUES((row_data->>'owner_id')::uuid,(row_data->>'contact_id')::uuid)
            ON CONFLICT DO NOTHING;
    END IF;
    UPDATE public.layered_memory_state SET dirty_revision=dirty_revision+1,
        next_due_at=COALESCE(next_due_at,clock_timestamp()+interval '350 milliseconds')
        WHERE owner_id=(row_data->>'owner_id')::uuid AND contact_id=(row_data->>'contact_id')::uuid;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.mark_owner_layered_memory_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected_owner uuid;
BEGIN
    affected_owner := CASE WHEN TG_OP='DELETE' THEN OLD.owner_id ELSE NEW.owner_id END;
    IF TG_OP <> 'DELETE' THEN
        INSERT INTO public.layered_memory_state(owner_id,contact_id) VALUES(affected_owner,NULL)
            ON CONFLICT DO NOTHING;
    END IF;
    UPDATE public.layered_memory_state SET dirty_revision=dirty_revision+1,
        next_due_at=COALESCE(next_due_at,clock_timestamp()+interval '350 milliseconds')
        WHERE owner_id=affected_owner AND contact_id IS NULL;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END; $$;

-- 已有合法L1也进入默认队列；只改变从未作过人工设置的初始状态。
INSERT INTO public.layered_memory_state(owner_id,contact_id)
    SELECT DISTINCT owner_id,contact_id FROM public.confirmed_memory ON CONFLICT DO NOTHING;
INSERT INTO public.layered_memory_state(owner_id,contact_id)
    SELECT DISTINCT owner_id,NULL::uuid FROM public.owner_memory ON CONFLICT DO NOTHING;
UPDATE public.layered_memory_state s SET enabled=true,status='stale',maintenance_allowed=true,
    dirty_revision=dirty_revision+1,next_due_at=clock_timestamp()+interval '350 milliseconds'
    WHERE s.last_action IS NULL AND s.status IN ('disabled','blocked','stale') AND (
        EXISTS(SELECT 1 FROM public.confirmed_memory m WHERE m.owner_id=s.owner_id AND m.contact_id=s.contact_id)
        OR s.contact_id IS NULL AND EXISTS(SELECT 1 FROM public.owner_memory m WHERE m.owner_id=s.owner_id));
