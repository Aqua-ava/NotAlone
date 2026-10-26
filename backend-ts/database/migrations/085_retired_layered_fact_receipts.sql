-- 退役保留084历史审计，但旧叶待修回执必须在同一纠正事务中解除。
CREATE FUNCTION public.clear_retired_layered_fact_receipts(affected_owner uuid, affected_contact uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE removed_count integer;
BEGIN
    DELETE FROM public.layered_memory_fact_correction receipt
    WHERE receipt.owner_id=affected_owner AND receipt.contact_id IS NOT DISTINCT FROM affected_contact
      AND NOT EXISTS (
        SELECT 1 FROM public.confirmed_memory memory
        WHERE memory.owner_id=affected_owner AND memory.contact_id=affected_contact
          AND memory.id=receipt.memory_id AND memory.revision=receipt.memory_revision AND memory.status='active'
        UNION ALL
        SELECT 1 FROM public.owner_memory memory
        WHERE memory.owner_id=affected_owner AND affected_contact IS NULL
          AND memory.id=receipt.memory_id AND memory.revision=receipt.memory_revision AND memory.status='active'
      );
    GET DIAGNOSTICS removed_count=ROW_COUNT;
    IF removed_count>0 THEN
        PERFORM public.bump_layered_correction_revision(affected_owner,affected_contact);
    END IF;
END; $$;

CREATE FUNCTION public.refresh_retired_layered_fact_receipts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status OR OLD.revision IS DISTINCT FROM NEW.revision THEN
        PERFORM public.clear_retired_layered_fact_receipts(NEW.owner_id,
            CASE WHEN TG_TABLE_NAME='confirmed_memory' THEN (to_jsonb(NEW)->>'contact_id')::uuid ELSE NULL END);
    END IF;
    RETURN NEW;
END; $$;
CREATE TRIGGER layered_fact_receipt_retirement AFTER UPDATE ON public.confirmed_memory
    FOR EACH ROW EXECUTE FUNCTION public.refresh_retired_layered_fact_receipts();
CREATE TRIGGER owner_layered_fact_receipt_retirement AFTER UPDATE ON public.owner_memory
    FOR EACH ROW EXECUTE FUNCTION public.refresh_retired_layered_fact_receipts();

-- 修复084期间已经完成纠正的遗留回执，不删除历史记忆、总结反馈或审计正文。
DO $$
DECLARE scope record;
BEGIN
    FOR scope IN SELECT DISTINCT owner_id,contact_id FROM public.layered_memory_fact_correction LOOP
        PERFORM public.clear_retired_layered_fact_receipts(scope.owner_id,scope.contact_id);
    END LOOP;
END; $$;
