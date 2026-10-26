BEGIN;

-- CLI 位置按 sort_seq 与分片游标排序，local_id 本身允许下降或重复。
-- 只放宽顺序比较，保留正整数、联系人隔离及所有来源记录。
DO $$
DECLARE item record;
BEGIN
    FOR item IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.local_wechat_observation'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%since_local_id <= last_local_id%'
    LOOP
        EXECUTE format('ALTER TABLE public.local_wechat_observation DROP CONSTRAINT %I', item.conname);
    END LOOP;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.local_wechat_observation'::regclass
          AND conname = 'local_wechat_observation_since_positive'
    ) THEN
        ALTER TABLE public.local_wechat_observation
            ADD CONSTRAINT local_wechat_observation_since_positive
            CHECK (since_local_id IS NULL OR since_local_id > 0);
    END IF;
END $$;

-- 扩充原唯一键而非合并历史记录；分片中相同 local_id 范围可对应不同位置。
DROP INDEX IF EXISTS public.local_wechat_observation_batch_unique;
CREATE UNIQUE INDEX local_wechat_observation_batch_unique
    ON public.local_wechat_observation (
        owner_id, contact_id, binding_id, mode,
        COALESCE(since_local_id, 0), last_local_id,
        COALESCE(since_cursor, ''), last_cursor
    );

CREATE SEQUENCE IF NOT EXISTS public.local_wechat_observation_commit_order_seq;
ALTER TABLE public.local_wechat_observation
    ADD COLUMN IF NOT EXISTS commit_order bigint;
-- 旧行保留 NULL，读取时回退到 read_at/id；不 UPDATE 原行，以免触发
-- 来源变更的依赖清理。新行在联系人锁内取得序号，排在所有旧行之后。
ALTER SEQUENCE public.local_wechat_observation_commit_order_seq
    OWNED BY public.local_wechat_observation.commit_order;
ALTER TABLE public.local_wechat_observation
    ALTER COLUMN commit_order SET DEFAULT nextval('public.local_wechat_observation_commit_order_seq');
CREATE INDEX IF NOT EXISTS local_wechat_observation_commit_order_idx
    ON public.local_wechat_observation (owner_id, contact_id, binding_id, commit_order DESC NULLS LAST, read_at DESC, id DESC)
    WHERE is_reliable;
COMMENT ON COLUMN public.local_wechat_observation.commit_order IS
    '联系人事务锁内分配的来源提交顺序；旧记录保持空值并按 read_at 与 id 稳定排序。';
COMMENT ON COLUMN public.local_wechat_observation.last_local_id IS
    '成功页末位置对应的外部 local_id；跨分片不保证数值递增，续读依据 last_cursor。';

COMMIT;
