BEGIN;

-- 候选携带有效期，确认时传递到已确认记忆。
ALTER TABLE public.memory_candidate
    ADD COLUMN valid_at timestamptz,
    ADD COLUMN invalid_at timestamptz;

COMMIT;
