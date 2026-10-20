-- 条件限定独立保存；旧记录留空，不重提取或回填业务内容。
ALTER TABLE public.memory_candidate ADD COLUMN conditions jsonb;
ALTER TABLE public.confirmed_memory ADD COLUMN conditions jsonb;
ALTER TABLE public.owner_memory ADD COLUMN conditions jsonb;
ALTER TABLE public.memory_candidate ADD CONSTRAINT memory_candidate_conditions_shape CHECK (conditions IS NULL OR (jsonb_typeof(conditions)='object' AND conditions->>'version'='1' AND jsonb_typeof(conditions->'items')='array' AND jsonb_array_length(conditions->'items') BETWEEN 1 AND 8));
ALTER TABLE public.confirmed_memory ADD CONSTRAINT confirmed_memory_conditions_shape CHECK (conditions IS NULL OR (jsonb_typeof(conditions)='object' AND conditions->>'version'='1' AND jsonb_typeof(conditions->'items')='array' AND jsonb_array_length(conditions->'items') BETWEEN 1 AND 8));
ALTER TABLE public.owner_memory ADD CONSTRAINT owner_memory_conditions_shape CHECK (conditions IS NULL OR (jsonb_typeof(conditions)='object' AND conditions->>'version'='1' AND jsonb_typeof(conditions->'items')='array' AND jsonb_array_length(conditions->'items') BETWEEN 1 AND 8));
