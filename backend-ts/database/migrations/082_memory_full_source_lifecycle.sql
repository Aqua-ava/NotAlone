-- 生命周期依赖与模型核验证明版本分离，v3 证据不冒充 v4。
ALTER TABLE public.memory_candidate ADD COLUMN requires_all_sources boolean NOT NULL DEFAULT false;
ALTER TABLE public.confirmed_memory ADD COLUMN requires_all_sources boolean NOT NULL DEFAULT false;
ALTER TABLE public.owner_memory ADD COLUMN requires_all_sources boolean NOT NULL DEFAULT false;
-- 已有多父合并也必须清理其候选副本，不只清理已采纳正文。
UPDATE public.confirmed_memory SET requires_all_sources=true WHERE cardinality(merge_parent_ids)>0;
UPDATE public.owner_memory SET requires_all_sources=true WHERE cardinality(merge_parent_ids)>0;
UPDATE public.memory_candidate SET requires_all_sources=true
WHERE id IN (SELECT source_candidate_id FROM public.confirmed_memory WHERE requires_all_sources
             UNION SELECT source_candidate_id FROM public.owner_memory WHERE requires_all_sources);
