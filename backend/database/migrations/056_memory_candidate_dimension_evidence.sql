BEGIN;

-- 旧候选保持 NULL；没有回填、重提取或重新采纳。
ALTER TABLE public.memory_candidate
    ADD COLUMN dimension_evidence jsonb;

ALTER TABLE public.memory_candidate
    ADD CONSTRAINT memory_candidate_dimension_evidence_check CHECK (
        dimension_evidence IS NULL OR COALESCE(
            jsonb_typeof(dimension_evidence) = 'object'
            AND jsonb_typeof(dimension_evidence->'version') = 'number'
            AND dimension_evidence->>'version' = '1'
            AND jsonb_typeof(dimension_evidence->'scope') = 'object'
            AND dimension_evidence->'scope'->>'owner_id' = owner_id::text
            AND dimension_evidence->'scope'->>'contact_id' = contact_id::text
            AND dimension_evidence->>'candidate_sha256' ~ '^[0-9a-f]{64}$'
            AND dimension_evidence->>'window_sha256' ~ '^[0-9a-f]{64}$'
            AND (
                jsonb_typeof(dimension_evidence->'pragmatics') = 'null'
                OR (
                    jsonb_typeof(dimension_evidence->'pragmatics') = 'object'
                    AND dimension_evidence->'pragmatics'->>'speech_act' IN (
                        'assertion', 'plan', 'question', 'request', 'report',
                        'correction', 'unknown'
                    )
                    AND dimension_evidence->'pragmatics'->>'assertion_status' IN (
                        'asserted', 'hypothetical', 'conditional', 'reported', 'unknown'
                    )
                    AND dimension_evidence->'pragmatics'->>'figurative_type' IN (
                        'literal', 'joke', 'sarcasm', 'hyperbole', 'unknown'
                    )
                )
            )
            AND jsonb_typeof(dimension_evidence->'messages') = 'array'
            AND jsonb_typeof(dimension_evidence->'paraphrase') IN ('array', 'null')
            AND jsonb_typeof(dimension_evidence->'reference') IN ('array', 'null')
            AND jsonb_typeof(dimension_evidence->'media') IN ('array', 'null')
            AND jsonb_typeof(dimension_evidence->'reported') IN ('array', 'null'),
            false
        )
    );

COMMENT ON COLUMN public.memory_candidate.dimension_evidence IS
    '带版本的同范围窗口、来源定位、语用标签快照与四类依据；NULL 或未知关系不构成自动采纳资格，无原文副本。';

COMMIT;
