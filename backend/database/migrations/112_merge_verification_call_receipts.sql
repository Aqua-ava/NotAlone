BEGIN;

-- 合并正文核验是独立模型调用，必须与原裁决及关系核验分别留可追溯回执。
ALTER TABLE public.memory_extraction_trace_call
    DROP CONSTRAINT memory_extraction_trace_call_purpose_check;
ALTER TABLE public.memory_extraction_trace_call
    ADD CONSTRAINT memory_extraction_trace_call_purpose_check
    CHECK (purpose IN (
        'extraction',
        'verification',
        'adjudication',
        'relation_verification',
        'merge_verification'
    ));

COMMIT;
