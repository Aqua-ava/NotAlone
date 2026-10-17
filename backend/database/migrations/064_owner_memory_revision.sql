-- 本人集合修订只记录真实事务变化，不回填旧来源或稳定性证明。
CREATE TABLE public.owner_memory_state (
    owner_id uuid PRIMARY KEY REFERENCES public.owner(id) ON DELETE CASCADE,
    memory_revision bigint NOT NULL DEFAULT 0 CHECK (memory_revision >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.owner_memory_state (owner_id) SELECT id FROM public.owner;

CREATE FUNCTION public.advance_owner_memory_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    old_owner uuid;
    new_owner uuid;
    affected_owner uuid;
BEGIN
    IF TG_OP='UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
    IF TG_OP<>'INSERT' THEN old_owner := OLD.owner_id; END IF;
    IF TG_OP<>'DELETE' THEN new_owner := NEW.owner_id; END IF;
    FOR affected_owner IN SELECT DISTINCT value FROM unnest(ARRAY[old_owner,new_owner]) AS value
        WHERE value IS NOT NULL LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended('owner:' || affected_owner::text,0));
        IF NOT EXISTS (SELECT 1 FROM public.owner WHERE id=affected_owner) THEN CONTINUE; END IF;
        INSERT INTO public.owner_memory_state (owner_id,memory_revision) VALUES (affected_owner,1)
        ON CONFLICT (owner_id) DO UPDATE SET
            memory_revision=owner_memory_state.memory_revision+1,updated_at=now();
    END LOOP;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER owner_memory_revision
    AFTER INSERT OR UPDATE OR DELETE ON public.owner_memory
    FOR EACH ROW EXECUTE FUNCTION public.advance_owner_memory_revision();
COMMENT ON TABLE public.owner_memory_state IS
    '本人资料集合的单调修订；删除与回滚沿实际 owner_memory 事务生效。';
COMMENT ON COLUMN public.owner_memory_state.owner_id IS
    '本人资料所属用户的隔离键；删除用户时级联清除。';
COMMENT ON COLUMN public.owner_memory_state.memory_revision IS
    '本人资料集合单调修订；原事务内递增，旧集合从零开始，不表示条目数。';
COMMENT ON COLUMN public.owner_memory_state.updated_at IS
    '集合修订最近一次写入的事务时间；不代表来源聊天或事实时间。';
