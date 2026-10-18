-- 多父合并保留旧版本；正文来源另以 ALL 依赖保存。
ALTER TABLE public.confirmed_memory ADD COLUMN merge_parent_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.owner_memory ADD COLUMN merge_parent_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.confirmed_memory ADD CONSTRAINT confirmed_merge_parent_count CHECK (cardinality(merge_parent_ids)=0 OR cardinality(merge_parent_ids)>=2);
ALTER TABLE public.owner_memory ADD CONSTRAINT owner_merge_parent_count CHECK (cardinality(merge_parent_ids)=0 OR cardinality(merge_parent_ids)>=2);
CREATE INDEX confirmed_memory_merge_parents ON public.confirmed_memory USING gin(merge_parent_ids);
CREATE INDEX owner_memory_merge_parents ON public.owner_memory USING gin(merge_parent_ids);
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
