-- 独立关系核验各有实际调用回执，不能覆盖原裁决的台账关联。
ALTER TABLE public.memory_extraction_trace_call
    DROP CONSTRAINT memory_extraction_trace_call_purpose_check;
ALTER TABLE public.memory_extraction_trace_call
    ADD CONSTRAINT memory_extraction_trace_call_purpose_check
    CHECK (purpose IN ('extraction', 'verification', 'adjudication', 'relation_verification'));
