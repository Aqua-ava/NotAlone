-- 多父合并保留旧版本；正文来源另以 ALL 依赖保存。
ALTER TABLE public.confirmed_memory ADD COLUMN merge_parent_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.owner_memory ADD COLUMN merge_parent_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.confirmed_memory ADD CONSTRAINT confirmed_merge_parent_count CHECK (cardinality(merge_parent_ids)=0 OR cardinality(merge_parent_ids)>=2);
ALTER TABLE public.owner_memory ADD CONSTRAINT owner_merge_parent_count CHECK (cardinality(merge_parent_ids)=0 OR cardinality(merge_parent_ids)>=2);
CREATE INDEX confirmed_memory_merge_parents ON public.confirmed_memory USING gin(merge_parent_ids);
CREATE INDEX owner_memory_merge_parents ON public.owner_memory USING gin(merge_parent_ids);
