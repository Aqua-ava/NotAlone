BEGIN;

-- 提取失败恢复：同一失败区间连续计数，达阈值后跳过并推进水位；
-- 最近一次跳过区间单独保留，不被后续成功推进清除。
ALTER TABLE public.memory_extraction_watermark
    ALTER COLUMN last_message_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS failure_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS failure_code text,
    ADD COLUMN IF NOT EXISTS failed_from_id uuid,
    ADD COLUMN IF NOT EXISTS failed_to_id uuid,
    ADD COLUMN IF NOT EXISTS last_skipped_from_id uuid,
    ADD COLUMN IF NOT EXISTS last_skipped_to_id uuid,
    ADD COLUMN IF NOT EXISTS last_skipped_code text,
    ADD COLUMN IF NOT EXISTS last_skipped_at timestamptz;

COMMENT ON COLUMN public.memory_extraction_watermark.last_message_id IS
    '已提取到的最后一条消息；NULL 表示首次运行尚未成功推进。';
COMMENT ON COLUMN public.memory_extraction_watermark.failure_count IS
    '同一失败区间的连续失败次数；成功推进或跳过时归零。';
COMMENT ON COLUMN public.memory_extraction_watermark.failed_from_id IS
    '正在计数的失败区间起点消息；区间变化时重新从 1 计数。';
COMMENT ON COLUMN public.memory_extraction_watermark.last_skipped_at IS
    '最近一次因连续输出不可用被跳过的区间时间；与计数分开，供人工重试查看。';

COMMIT;
