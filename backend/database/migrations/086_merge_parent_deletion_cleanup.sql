-- 正文删除路径先捕获依赖图；物理删除时清除残余的多父导航引用。
CREATE FUNCTION public.clear_deleted_merge_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('UPDATE public.%I SET merge_parent_ids=''{}''::uuid[] WHERE owner_id=$1 AND id<>$2 AND $2=ANY(merge_parent_ids)', TG_TABLE_NAME)
    USING OLD.owner_id, OLD.id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER confirmed_clear_merge_parent AFTER DELETE ON public.confirmed_memory
FOR EACH ROW EXECUTE FUNCTION public.clear_deleted_merge_parent();
CREATE TRIGGER owner_clear_merge_parent AFTER DELETE ON public.owner_memory
FOR EACH ROW EXECUTE FUNCTION public.clear_deleted_merge_parent();
