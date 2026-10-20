BEGIN;

-- INSERT 按整条语句的范围失效，避免逐行复制正文及重复清理投影。
CREATE FUNCTION public.invalidate_inserted_message_overviews()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    affected_owner uuid;
    affected_contacts uuid[];
    identifiers uuid[];
BEGIN
    FOR affected_owner IN SELECT DISTINCT owner_id FROM inserted_rows ORDER BY owner_id LOOP
        -- 与 writer、概览重建及删除共享 owner 锁；不再申请 contact 锁。
        PERFORM pg_advisory_xact_lock(hashtextextended('owner:' || affected_owner::text,0));
        IF TG_TABLE_NAME = 'message' THEN
            SELECT array_agg(DISTINCT contact_id), array_agg(id)
                INTO affected_contacts, identifiers
                FROM inserted_rows WHERE owner_id=affected_owner;
        ELSE
            SELECT array_agg(DISTINCT row.contact_id), array_agg(DISTINCT dependency.id)
                INTO affected_contacts, identifiers
                FROM inserted_rows AS row
                CROSS JOIN LATERAL unnest(ARRAY[
                    row.id,row.message_id,row.source_document_id,row.observation_id
                ]) AS dependency(id)
                WHERE row.owner_id=affected_owner;
        END IF;
        DELETE FROM public.relationship_overview_projection
            WHERE owner_id=affected_owner AND (scope_kind='owner'
                OR contact_id=ANY(affected_contacts)
                OR memory_ids && identifiers OR source_ids && identifiers);
    END LOOP;
    RETURN NULL;
END;
$$;

DROP TRIGGER relationship_overview_message ON public.message;
CREATE TRIGGER relationship_overview_message
    AFTER UPDATE OR DELETE ON public.message
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_relationship_overview_projection();
CREATE TRIGGER relationship_overview_message_insert
    AFTER INSERT ON public.message REFERENCING NEW TABLE AS inserted_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_inserted_message_overviews();

DROP TRIGGER relationship_overview_message_source_ref ON public.message_source_ref;
CREATE TRIGGER relationship_overview_message_source_ref
    AFTER UPDATE OR DELETE ON public.message_source_ref
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_relationship_overview_projection();
CREATE TRIGGER relationship_overview_message_source_ref_insert
    AFTER INSERT ON public.message_source_ref REFERENCING NEW TABLE AS inserted_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_inserted_message_overviews();

COMMIT;
