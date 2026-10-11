BEGIN;

-- 仅扩展稳定输入类型；携入正文继续从原候选版本解析，不建长期副本表。
ALTER TABLE public.assistant_session_input
    DROP CONSTRAINT assistant_session_input_input_type_check;
ALTER TABLE public.assistant_session_input
    ADD CONSTRAINT assistant_session_input_input_type_check
    CHECK (input_type IN (
        'generation', 'response_exploration', 'purpose_exploration', 'candidate_carry'
    ));

COMMIT;
