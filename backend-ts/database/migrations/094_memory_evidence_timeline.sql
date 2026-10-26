-- 新旧关系元数据保持可选；旧记录未知，不重解释业务资料。
ALTER TABLE public.memory_candidate ADD COLUMN evolution jsonb;
ALTER TABLE public.confirmed_memory ADD COLUMN evolution jsonb;
ALTER TABLE public.owner_memory ADD COLUMN evolution jsonb;
ALTER TABLE public.memory_candidate ADD CONSTRAINT memory_candidate_evolution_shape CHECK (evolution IS NULL OR (jsonb_typeof(evolution)='object' AND evolution->>'version'='1'));
ALTER TABLE public.confirmed_memory ADD CONSTRAINT confirmed_memory_evolution_shape CHECK (evolution IS NULL OR (jsonb_typeof(evolution)='object' AND evolution->>'version'='1'));
ALTER TABLE public.owner_memory ADD CONSTRAINT owner_memory_evolution_shape CHECK (evolution IS NULL OR (jsonb_typeof(evolution)='object' AND evolution->>'version'='1'));

-- 读取已用事实关联的待解决反证，不遍历联系人历史正文。
CREATE INDEX memory_candidate_pending_conflict_versions_idx
ON public.memory_candidate USING gin ((evolution->'related_versions'))
WHERE status='pending' AND evolution->>'kind'='unresolved_conflict';
