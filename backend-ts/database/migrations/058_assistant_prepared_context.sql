BEGIN;
-- 有界回复材料只随所属输入保留；来源失效清理与助手会话删除共同覆盖。
ALTER TABLE public.assistant_session_turn ADD COLUMN prepared_context jsonb;
CREATE FUNCTION public.clear_unavailable_prepared_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.input_payload IS NULL OR NEW.state IN ('redacted','unavailable') THEN
        NEW.prepared_context := NULL;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER clear_unavailable_prepared_context BEFORE UPDATE ON public.assistant_session_turn
FOR EACH ROW EXECUTE FUNCTION public.clear_unavailable_prepared_context();
COMMIT;
