"""从合成消息窗口观察最终去向，不写入记忆。"""
import unittest

from notalone.memory_extraction.evaluation import build_window, evaluate_case
from notalone.memory_extraction.evaluation_cases import CASES
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
        self.assertFalse(result.passed)

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
