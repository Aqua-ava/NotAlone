"""从合成消息窗口观察最终去向，不写入记忆。"""
import unittest

from notalone.memory_extraction.evaluation import (
    EvaluationResult,
    build_window,
    evaluate_case,
    summarize,
)
from notalone.memory_extraction.evaluation_cases import CASES, EvaluationCase
from notalone.memory_extraction.adapters import LangChainExtractionRuntime
from tests.unit.memory_extraction.test_adapters import _structured_response
from tests.unit.memory_extraction.test_flow import _payload
from tests.unit.reply.test_langchain_vertical_slice import ToolCallingFakeModel


CASES_BY_NAME = {case.name: case for case in CASES}


class EvaluationTest(unittest.TestCase):
    def test_literal_fact_with_risk_is_pending(self):
        case = CASES_BY_NAME["明确事实"]
        window = build_window(case)
        payload = _payload(window.messages[0].message_id)
        payload['risk_flags'] = ['financial']
        model = ToolCallingFakeModel(responses=[_structured_response((payload,))])
        result = evaluate_case(case, window, LangChainExtractionRuntime(model=model))
        self.assertEqual(result.actual, 'pending')
        self.assertFalse(result.passed)

    def test_runtime_failure_cannot_pass_no_memory_expectation(self):
        from langchain_core.messages import AIMessage
        case = CASES_BY_NAME["反讽"]
        window = build_window(case)
        model = ToolCallingFakeModel(responses=[AIMessage(content='无结构化输出')])
        result = evaluate_case(case, window, LangChainExtractionRuntime(model=model))
        self.assertFalse(result.passed)
        self.assertIsNotNone(result.failure_reason)

    def test_mixed_subjects_fail_even_when_one_matches(self):
        case = CASES_BY_NAME["主体归属：用户计划"]
        window = build_window(case)
        first = _payload(window.messages[0].message_id)
        first.update(subject='self', speech_act='plan')
        second = {**first, 'subject': 'contact'}
        model = ToolCallingFakeModel(responses=[_structured_response((first, second))])
        result = evaluate_case(case, window, LangChainExtractionRuntime(model=model))
        self.assertEqual(result.actual, 'pending')
        self.assertFalse(result.subject_ok)
        self.assertFalse(result.passed)

    def test_low_confidence_and_plan_never_auto_adopt(self):
        for fields in ({'confidence': 0.69}, {'speech_act': 'plan'}):
            with self.subTest(fields=fields):
                case = CASES_BY_NAME["明确事实"]
                window = build_window(case)
                payload = {**_payload(window.messages[0].message_id), **fields}
                model = ToolCallingFakeModel(responses=[_structured_response((payload,))])
                result = evaluate_case(case, window, LangChainExtractionRuntime(model=model))
                self.assertEqual(result.actual, 'pending')

    def test_context_only_evidence_is_rejected(self):
        case = CASES_BY_NAME["主体归属：用户计划"]
        window = build_window(case)
        payload = _payload(window.messages[1].message_id)
        model = ToolCallingFakeModel(responses=[_structured_response((payload,))])
        result = evaluate_case(case, window, LangChainExtractionRuntime(model=model))
        self.assertEqual(result.actual, 'none')
        self.assertEqual(result.rejected_count, 1)
        self.assertEqual(result.error_kind, 'general')
        self.assertFalse(result.passed)

    def test_false_fact_classification_for_auto_adopted_joke(self):
        case = CASES_BY_NAME["反讽"]
        window = build_window(case)
        payload = _payload(window.messages[1].message_id)
        model = ToolCallingFakeModel(responses=[_structured_response((payload,))])
        result = evaluate_case(case, window, LangChainExtractionRuntime(model=model))
        self.assertEqual(result.actual, 'auto')
        self.assertEqual(result.error_kind, 'false_fact')

    def test_wrong_subject_classification(self):
        case = CASES_BY_NAME["主体归属：用户计划"]
        window = build_window(case)
        payload = _payload(window.messages[0].message_id)
        payload.update(subject='contact', speech_act='plan')
        model = ToolCallingFakeModel(responses=[_structured_response((payload,))])
        result = evaluate_case(case, window, LangChainExtractionRuntime(model=model))
        self.assertFalse(result.subject_ok)
        self.assertEqual(result.error_kind, 'wrong_subject')

    def test_subject_check_is_vacuous_without_candidate(self):
        case = EvaluationCase(
            name='合成空窗口', dimension='subject',
            messages=(('contact', '好的。'),), targets=(0,),
            expect='none', expect_subject='self',
        )
        window = build_window(case)
        model = ToolCallingFakeModel(responses=[_structured_response(())])
        result = evaluate_case(case, window, LangChainExtractionRuntime(model=model))
        self.assertEqual(result.actual, 'none')
        self.assertTrue(result.subject_ok)
        self.assertTrue(result.passed)

    def test_text_fidelity_expectations(self):
        base = dict(
            dimension='paraphrase', messages=(('contact', '我不喝酒。'),),
            targets=(0,), expect='auto',
        )
        passing = EvaluationCase(
            name='保真通过', expect_text_contains=('不喝',), **base,
        )
        failing = EvaluationCase(
            name='保真失败', expect_text_contains=('能喝',), **base,
        )
        excluded = EvaluationCase(
            name='禁用词命中', expect_text_excludes=('能喝',), **base,
        )
        scenarios = (
            (passing, True, '联系人不喝酒'),
            (failing, False, '联系人不喝酒'),
            (excluded, False, '联系人能喝酒'),
        )
        for case, text_ok, payload_text in scenarios:
            with self.subTest(case=case.name):
                window = build_window(case)
                payload = _payload(window.messages[0].message_id, text=payload_text)
                model = ToolCallingFakeModel(responses=[_structured_response((payload,))])
                result = evaluate_case(case, window, LangChainExtractionRuntime(model=model))
                self.assertEqual(result.text_ok, text_ok)
                self.assertEqual(result.passed, text_ok)

    def test_validity_field_expectations(self):
        base = dict(
            dimension='time', messages=(('contact', '我下周去北京。'),),
            targets=(0,), expect='auto',
        )
        want_valid = EvaluationCase(name='应填生效时间', expect_valid_at=True, **base)
        deny_valid = EvaluationCase(name='不应填生效时间', expect_valid_at=False, **base)
        want_invalid = EvaluationCase(name='应填失效时间', expect_invalid_at=True, **base)
        for case, validity_ok, payload_valid in (
            (want_valid, True, '2026-09-22T09:00:00+08:00'),
            (want_valid, False, None),
            (deny_valid, True, None),
            (deny_valid, False, '2026-09-22T09:00:00+08:00'),
            (want_invalid, True, '2026-09-30T09:00:00+08:00'),
            (want_invalid, False, None),
        ):
            with self.subTest(case=case.name, ok=validity_ok, value=payload_valid):
                window = build_window(case)
                overrides = {'valid_at': payload_valid} if case.expect_valid_at is not None else {'invalid_at': payload_valid}
                payload = _payload(window.messages[0].message_id, **overrides)
                model = ToolCallingFakeModel(responses=[_structured_response((payload,))])
                result = evaluate_case(case, window, LangChainExtractionRuntime(model=model))
                self.assertEqual(result.validity_ok, validity_ok)
                self.assertEqual(result.passed, validity_ok)

    def test_dimension_gate_summary(self):
        def make(error_kind=None):
            return EvaluationResult(
                name='合成', dimension='subject', expected='auto', actual='auto',
                passed=error_kind is None, subject_ok=error_kind != 'wrong_subject',
                labels_ok=True, expected_subject=None, expected_labels=(),
                facts=(), rejected_count=0, failure_reason=None,
                text_ok=True, validity_ok=True, error_kind=error_kind,
            )

        under = summarize(tuple(make() for _ in range(14)))[0]
        self.assertEqual((under.cases, under.meets_gate), (14, False))
        with_one_general = summarize(
            tuple(make() for _ in range(14)) + (make('general'),)
        )[0]
        self.assertEqual(
            (with_one_general.cases, with_one_general.general_errors,
             with_one_general.meets_gate),
            (15, 1, True),
        )
        too_many_general = summarize(
            tuple(make() for _ in range(13)) + tuple(make('general') for _ in range(2))
        )[0]
        self.assertFalse(too_many_general.meets_gate)
        fake_fact = summarize(
            tuple(make() for _ in range(14)) + (make('false_fact'),)
        )[0]
        self.assertFalse(fake_fact.meets_gate)
        wrong_subject = summarize(
            tuple(make() for _ in range(14)) + (make('wrong_subject'),)
        )[0]
        self.assertFalse(wrong_subject.meets_gate)

    def test_expected_labels_detect_reported_completed_action(self):
        case = CASES_BY_NAME["已发生行动"]
        window = build_window(case)
        payload = _payload(window.messages[0].message_id)
        payload.update(speech_act='report', assertion_status='reported')
        model = ToolCallingFakeModel(responses=[_structured_response((payload,))])
        result = evaluate_case(case, window, LangChainExtractionRuntime(model=model))
        self.assertEqual(result.actual, 'pending')
        self.assertFalse(result.labels_ok)
        self.assertFalse(result.passed)

    def test_no_evaluation_credentials_skip_even_with_production_key(self):
        import contextlib
        import io
        from unittest.mock import patch
        from notalone.memory_extraction.evaluation import main
        output = io.StringIO()
        with patch.dict('os.environ', {'NOTALONE_DEEPSEEK_API_KEY': 'synthetic'}, clear=True):
            with patch('socket.socket', side_effect=AssertionError('禁止网络')):
                with contextlib.redirect_stdout(output):
                    self.assertEqual(main([]), 2)
        self.assertIn('[skip]', output.getvalue())
