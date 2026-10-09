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
from tests.unit.memory_extraction.test_flow import RecordingRuntime, _payload
from tests.unit.reply.test_langchain_vertical_slice import ToolCallingFakeModel


CASES_BY_NAME = {case.name: case for case in CASES}


def baseline_evaluate(case, window, runtime):
    return evaluate_case(case, window, runtime, baseline=True)


class EvaluationTest(unittest.TestCase):
    def test_correct_candidate_does_not_hide_extra_false_fact(self):
        case = CASES_BY_NAME["保真：否定喝酒"]
        window = build_window(case)
        source = window.messages[0].message_id
        result = baseline_evaluate(case, window, RecordingRuntime((
            _payload(source, text="联系人不喝酒。"),
            _payload(source, text="联系人每天喝半斤白酒。"),
        )))
        self.assertFalse(result.passed)
        self.assertEqual(result.error_kind, "false_fact")

    def test_auto_negation_reversal_is_false_fact(self):
        case = CASES_BY_NAME["保真：否定喝酒"]
        window = build_window(case)
        result = baseline_evaluate(case, window, RecordingRuntime((
            _payload(window.messages[0].message_id, text="联系人喝酒。"),
        )))
        self.assertEqual(result.error_kind, "false_fact")

    def test_negation_reversal_cannot_meet_dimension_gate(self):
        import re
        from notalone.memory_extraction.evaluation_cases import ClaimExpectation
        controls = (
            "喜欢下棋", "住在杭州", "会弹钢琴", "爱喝红茶", "养了两只猫", "从事设计工作",
            "早饭喝豆浆", "不吃香菜", "会游泳", "喜欢看小说", "每天跑步", "爱看电影",
            "周末打羽毛球", "已读完活着",
        )
        results = []
        for index, predicate in enumerate(controls):
            text = f"联系人{predicate}。"
            case = EvaluationCase(
                name=f"独立对照{index}", dimension="paraphrase",
                messages=(("contact", f"我{predicate}。"),), targets=(0,), expect="auto",
                expected_claims=(ClaimExpectation("contact", "auto", (re.escape(text),)),),
            )
            window = build_window(case)
            results.append(baseline_evaluate(case, window, RecordingRuntime((
                _payload(window.messages[0].message_id, text=text),
            ))))
        control = CASES_BY_NAME["保真：否定喝酒"]
        window = build_window(control)
        results.append(baseline_evaluate(control, window, RecordingRuntime((
            _payload(window.messages[0].message_id, text="联系人喝酒。"),
        ))))
        summary = summarize(results)[0]
        self.assertEqual(summary.semantic_scenarios, 15)
        self.assertEqual(summary.false_facts, 1)
        self.assertFalse(summary.meets_gate)

    def test_allowed_paraphrases_match_entire_single_candidate(self):
        from notalone.memory_extraction.evaluation_cases import ClaimExpectation
        case = EvaluationCase(
            name="合成严格否定", dimension="paraphrase",
            messages=(("contact", "我不喝酒。"),), targets=(0,), expect="auto",
            expected_claims=(ClaimExpectation(
                subject="contact", destination="auto",
                text_patterns=(r"(?:联系人)?(?:不喝酒|不饮酒|滴酒不沾)[。]?",),
            ),),
        )
        window = build_window(case)
        for text, passed in (
            ("联系人不饮酒。", True),
            ("联系人不喝酒，每天喝半斤白酒。", False),
        ):
            with self.subTest(text=text):
                result = baseline_evaluate(case, window, RecordingRuntime((
                    _payload(window.messages[0].message_id, text=text),
                )))
                self.assertEqual(result.passed, passed)
                self.assertEqual(result.error_kind, None if passed else "false_fact")

    def test_wrong_subject_is_counted_independently_of_false_fact(self):
        from notalone.memory_extraction.evaluation_cases import ClaimExpectation
        case = EvaluationCase(
            name="合成分别归属", dimension="subject",
            messages=(("contact", "我住苏州，你住南京。"),), targets=(0,), expect="auto",
            expected_claims=(
                ClaimExpectation("contact", "auto", (r"(?:联系人|用户)住苏州。?",)),
                ClaimExpectation("self", "auto", (r"(?:联系人|用户)住南京。?",)),
            ),
        )
        window = build_window(case)
        result = baseline_evaluate(case, window, RecordingRuntime((
            _payload(window.messages[0].message_id, text="用户住苏州。", subject="self"),
            _payload(window.messages[0].message_id, text="用户住南京。", subject="self"),
        )))
        self.assertEqual(result.false_fact_count, 1)
        self.assertEqual(result.wrong_subject_count, 1)
        summary = summarize((result,))[0]
        self.assertEqual((summary.false_facts, summary.wrong_subjects), (1, 1))

    def test_baseline_keeps_preexisting_unverified_risk(self):
        case = CASES_BY_NAME["明确事实"]
        window = build_window(case)
        result = baseline_evaluate(case, window, RecordingRuntime((
            _payload(window.messages[0].message_id, risk_flags=["semantic:unverified"]),
        )))
        self.assertEqual(result.actual, "pending")
        self.assertFalse(result.verification_enabled)

    def test_evaluation_cli_defaults_to_source_verification(self):
        import contextlib
        import io
        from unittest.mock import patch
        from notalone.memory_extraction.evaluation import main
        case = CASES_BY_NAME["明确事实"]
        window = build_window(case)
        sample = baseline_evaluate(case, window, RecordingRuntime((
            _payload(window.messages[0].message_id),
        )))
        with patch.dict("os.environ", {"NOTALONE_EVALUATION_API_KEY": "synthetic"}, clear=True):
            with patch("notalone.reply.adapters.deepseek_provider.build_deepseek_model") as build:
                build.return_value.model_name = "synthetic-model"
                with patch("notalone.memory_extraction.adapters.LangChainExtractionRuntime"):
                    with patch("notalone.memory_extraction.verification_adapters.LangChainSourceVerificationRuntime") as verifier:
                        with patch("notalone.memory_extraction.evaluation.evaluate_case", return_value=sample) as evaluate:
                            with contextlib.redirect_stdout(io.StringIO()):
                                self.assertEqual(main(["--case", "明确事实"]), 0)
                            self.assertIs(evaluate.call_args.kwargs["verification_runtime"], verifier.return_value)
                            self.assertFalse(evaluate.call_args.kwargs["baseline"])
                            verifier.assert_called_once_with(model=build.return_value)

    def test_default_evaluation_keeps_unverified_facts_pending(self):
        case = CASES_BY_NAME["保真：否定喝酒"]
        window = build_window(case)
        result = evaluate_case(case, window, RecordingRuntime((
            _payload(window.messages[0].message_id, text="联系人不喝酒。"),
        )))
        self.assertEqual(result.actual, "pending")
        self.assertIn("semantic:unverified", result.facts[0]["risk_flags"])
        self.assertFalse(result.verification_enabled)
        self.assertFalse(result.passed)

    def test_verification_enabled_evaluation_uses_the_production_guard(self):
        from notalone.memory_extraction.models import ExtractedFact, ExtractionWindow
        class SupportingRuntime:
            def verify(self, *, window: ExtractionWindow, facts: tuple[ExtractedFact, ...]):
                return tuple({
                    "candidate_index": index, "verdict": "supported", "issues": [],
                    "evidence": [{"message_id": str(fact.source_message_ids[0]),
                                  "quote": window.messages[0].text}],
                } for index, fact in enumerate(facts))
        case = CASES_BY_NAME["保真：否定喝酒"]
        window = build_window(case)
        result = evaluate_case(case, window, RecordingRuntime((
            _payload(window.messages[0].message_id, text="联系人不饮酒。"),
        )), verification_runtime=SupportingRuntime())
        self.assertTrue(result.verification_enabled)
        self.assertTrue(result.passed)
        self.assertEqual(result.actual, "auto")

    def test_time_mismatch_on_auto_candidate_is_a_false_fact(self):
        from notalone.memory_extraction.evaluation_cases import ClaimExpectation
        case = EvaluationCase(
            "合成无时间边界事实", "time", (("contact", "我喜欢下棋。"),), (0,), "auto",
            expected_claims=(ClaimExpectation("contact", "auto", (r"联系人喜欢下棋。?",)),),
        )
        window = build_window(case)
        result = baseline_evaluate(case, window, RecordingRuntime((
            _payload(window.messages[0].message_id, text="联系人喜欢下棋。",
                     valid_at="2026-09-01T00:00:00+00:00"),
        )))
        self.assertTrue(result.text_ok)
        self.assertFalse(result.validity_ok)
        self.assertEqual(result.false_fact_count, 1)
        self.assertEqual(result.error_kind, "false_fact")

    def test_baseline_leaves_malformed_candidates_to_the_public_guard(self):
        case = CASES_BY_NAME["明确事实"]
        window = build_window(case)
        result = baseline_evaluate(case, window, RecordingRuntime((
            _payload(window.messages[0].message_id, risk_flags=None),
            _payload(window.messages[0].message_id, risk_flags=["semantic:unverified"],
                     source_message_ids=None),
        )))
        self.assertEqual(result.rejected_count, 2)
        self.assertEqual(result.actual, "none")
        self.assertFalse(result.passed)

    def test_literal_fact_with_risk_is_pending(self):
        case = CASES_BY_NAME["明确事实"]
        window = build_window(case)
        payload = _payload(window.messages[0].message_id)
        payload['risk_flags'] = ['financial']
        model = ToolCallingFakeModel(responses=[_structured_response((payload,))])
        result = baseline_evaluate(case, window, LangChainExtractionRuntime(model=model))
        self.assertEqual(result.actual, 'pending')
        self.assertFalse(result.passed)

    def test_runtime_failure_cannot_pass_no_memory_expectation(self):
        from langchain_core.messages import AIMessage
        case = CASES_BY_NAME["反讽"]
        window = build_window(case)
        model = ToolCallingFakeModel(responses=[AIMessage(content='无结构化输出')])
        result = baseline_evaluate(case, window, LangChainExtractionRuntime(model=model))
        self.assertFalse(result.passed)
        self.assertIsNotNone(result.failure_reason)

    def test_mixed_subjects_fail_even_when_one_matches(self):
        case = CASES_BY_NAME["主体归属：用户计划"]
        window = build_window(case)
        first = _payload(window.messages[0].message_id)
        first.update(subject='self', speech_act='plan')
        second = {**first, 'subject': 'contact'}
        model = ToolCallingFakeModel(responses=[_structured_response((first, second))])
        result = baseline_evaluate(case, window, LangChainExtractionRuntime(model=model))
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
                result = baseline_evaluate(case, window, LangChainExtractionRuntime(model=model))
                self.assertEqual(result.actual, 'pending')

    def test_context_only_evidence_is_rejected(self):
        case = CASES_BY_NAME["主体归属：用户计划"]
        window = build_window(case)
        payload = _payload(window.messages[1].message_id)
        model = ToolCallingFakeModel(responses=[_structured_response((payload,))])
        result = baseline_evaluate(case, window, LangChainExtractionRuntime(model=model))
        self.assertEqual(result.actual, 'none')
        self.assertEqual(result.rejected_count, 1)
        self.assertEqual(result.error_kind, 'general')
        self.assertFalse(result.passed)

    def test_false_fact_classification_for_auto_adopted_joke(self):
        case = CASES_BY_NAME["反讽"]
        window = build_window(case)
        payload = _payload(window.messages[1].message_id)
        model = ToolCallingFakeModel(responses=[_structured_response((payload,))])
        result = baseline_evaluate(case, window, LangChainExtractionRuntime(model=model))
        self.assertEqual(result.actual, 'auto')
        self.assertEqual(result.error_kind, 'false_fact')

    def test_wrong_subject_classification(self):
        case = CASES_BY_NAME["主体归属：用户计划"]
        window = build_window(case)
        payload = _payload(window.messages[0].message_id)
        payload.update(subject='contact', speech_act='plan')
        model = ToolCallingFakeModel(responses=[_structured_response((payload,))])
        result = baseline_evaluate(case, window, LangChainExtractionRuntime(model=model))
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
        result = baseline_evaluate(case, window, LangChainExtractionRuntime(model=model))
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
                result = baseline_evaluate(case, window, LangChainExtractionRuntime(model=model))
                self.assertEqual(result.text_ok, text_ok)
                self.assertEqual(result.passed, text_ok)

    def test_completed_cancellation_preserves_fact_without_live_plan(self):
        case = CASES_BY_NAME["保真：取消见面"]
        window = build_window(case)
        payload = _payload(
            window.messages[0].message_id,
            text="原本约的周六见面取消了。",
            subject="shared",
        )
        model = ToolCallingFakeModel(responses=[_structured_response((payload,))])
        result = baseline_evaluate(case, window, LangChainExtractionRuntime(model=model))
        self.assertEqual(result.actual, 'auto')
        self.assertTrue(result.passed)

    def test_validity_field_expectations(self):
        base = dict(
            dimension='time', messages=(('contact', '我从月初起就在北京。'),),
            targets=(0,), expect='auto',
        )
        want_valid = EvaluationCase(name='应填生效时间', expect_valid_at=True, **base)
        deny_valid = EvaluationCase(name='不应填生效时间', expect_valid_at=False, **base)
        want_invalid = EvaluationCase(name='应填失效时间', expect_invalid_at=True, **base)
        for case, validity_ok, payload_valid in (
            (want_valid, True, '2026-09-01T09:00:00+08:00'),
            (want_valid, False, None),
            (deny_valid, True, None),
            (deny_valid, False, '2026-09-01T09:00:00+08:00'),
            (want_invalid, True, '2026-09-30T09:00:00+08:00'),
            (want_invalid, False, None),
        ):
            with self.subTest(case=case.name, ok=validity_ok, value=payload_valid):
                window = build_window(case)
                overrides = {'valid_at': payload_valid} if case.expect_valid_at is not None else {'invalid_at': payload_valid}
                payload = _payload(window.messages[0].message_id, **overrides)
                model = ToolCallingFakeModel(responses=[_structured_response((payload,))])
                result = baseline_evaluate(case, window, LangChainExtractionRuntime(model=model))
                self.assertEqual(result.validity_ok, validity_ok)
                self.assertEqual(result.passed, validity_ok)

    def test_explicit_period_checks_exact_dates_and_timezone_equivalence(self):
        case = EvaluationCase(
            name='合成当周临时状态', dimension='time',
            messages=(('self', '本周临时值班，下周回原办公室。'),),
            targets=(0,), expect='auto',
            expect_valid_at_iso='2026-09-15T00:00:00+00:00',
            expect_invalid_at_iso='2026-09-21T00:00:00+00:00',
        )
        window = build_window(case)
        for start, end, correct in (
            ('2026-09-15T00:00:00+00:00', '2026-09-21T00:00:00+00:00', True),
            ('2026-09-15T08:00:00+08:00', '2026-09-21T08:00:00+08:00', True),
            ('2026-09-14T00:00:00+00:00', '2026-09-21T00:00:00+00:00', False),
            ('2026-09-15T00:00:00+00:00', '2026-09-22T00:00:00+00:00', False),
        ):
            with self.subTest(start=start, end=end):
                payload = _payload(
                    window.messages[0].message_id,
                    subject='self', valid_at=start, invalid_at=end,
                )
                model = ToolCallingFakeModel(responses=[_structured_response((payload,))])
                result = baseline_evaluate(case, window, LangChainExtractionRuntime(model=model))
                self.assertEqual(result.validity_ok, correct)
                self.assertEqual(result.passed, correct)

    def test_exact_period_cannot_be_satisfied_by_one_of_two_facts(self):
        case = EvaluationCase(
            name='合成整组临时状态', dimension='time',
            messages=(('self', '本周临时在北区办公室值班。'),),
            targets=(0,), expect='auto',
            expect_valid_at_iso='2026-09-15T00:00:00+00:00',
            expect_invalid_at_iso='2026-09-21T00:00:00+00:00',
        )
        window = build_window(case)
        dated = _payload(
            window.messages[0].message_id, subject='self',
            text='用户本周临时在北区办公室值班。',
            valid_at='2026-09-15T00:00:00+00:00',
            invalid_at='2026-09-21T00:00:00+00:00',
        )
        unbounded = {**dated, 'text': '用户在北区办公室值班。',
                     'valid_at': None, 'invalid_at': None}
        model = ToolCallingFakeModel(responses=[_structured_response((dated, unbounded))])
        result = baseline_evaluate(case, window, LangChainExtractionRuntime(model=model))
        self.assertEqual(len(result.facts), 2)
        self.assertFalse(result.validity_ok)
        self.assertFalse(result.passed)

    def test_dimension_gate_summary(self):
        def make(index, error_kind=None):
            return EvaluationResult(
                name=f'合成{index}', dimension='subject', expected='auto', actual='auto',
                passed=error_kind is None, subject_ok=error_kind != 'wrong_subject',
                labels_ok=True, expected_subject=None, expected_labels=(),
                facts=(), rejected_count=0, failure_reason=None,
                text_ok=True, validity_ok=True, error_kind=error_kind,
                semantic_annotated=True, semantic_case_id=f'场景{index}',
            )

        under = summarize(tuple(make(index) for index in range(14)))[0]
        self.assertEqual((under.cases, under.meets_gate), (14, False))
        with_one_general = summarize(
            tuple(make(index) for index in range(14)) + (make(14, 'general'),)
        )[0]
        self.assertEqual(
            (with_one_general.cases, with_one_general.general_errors,
             with_one_general.meets_gate),
            (15, 1, True),
        )
        too_many_general = summarize(
            tuple(make(index) for index in range(13)) + tuple(make(14, 'general') for _ in range(2))
        )[0]
        self.assertFalse(too_many_general.meets_gate)
        fake_fact = summarize(
            tuple(make(index) for index in range(14)) + (make(14, 'false_fact'),)
        )[0]
        self.assertFalse(fake_fact.meets_gate)
        wrong_subject = summarize(
            tuple(make(index) for index in range(14)) + (make(14, 'wrong_subject'),)
        )[0]
        self.assertFalse(wrong_subject.meets_gate)

    def test_dimension_gate_follows_adr_027_without_semantic_coverage(self):
        """达标签只看 15 条、假事 0、记错人 0、一般错误 ≤1（ADR-027 第 2 条）。"""

        def make(index, error_kind=None, *, annotated=False):
            return EvaluationResult(
                name=f'合成{index}', dimension='subject', expected='auto', actual='auto',
                passed=error_kind is None, subject_ok=error_kind != 'wrong_subject',
                labels_ok=True, expected_subject=None, expected_labels=(),
                facts=(), rejected_count=0, failure_reason=None,
                text_ok=True, validity_ok=True, error_kind=error_kind,
                semantic_annotated=annotated,
                semantic_case_id=f'场景{index}' if annotated else None,
            )

        unannotated = summarize(tuple(make(index) for index in range(15)))[0]
        self.assertEqual(
            (unannotated.cases, unannotated.passed, unannotated.meets_gate),
            (15, 15, True),
        )
        self.assertEqual(
            (unannotated.semantic_cases, unannotated.semantic_scenarios),
            (0, 0),
        )

    def test_dimension_gate_reports_semantic_coverage_separately(self):
        def annotated(index, *, annotated_case):
            return EvaluationResult(
                name=f'合成{index}', dimension='subject', expected='auto', actual='auto',
                passed=True, subject_ok=True, labels_ok=True,
                expected_subject=None, expected_labels=(), facts=(),
                rejected_count=0, failure_reason=None, text_ok=True,
                validity_ok=True, error_kind=None,
                semantic_annotated=annotated_case,
                semantic_case_id=f'场景{index}' if annotated_case else None,
            )

        summary = summarize(tuple(
            annotated(index, annotated_case=index < 3) for index in range(15)
        ))[0]

        self.assertTrue(summary.meets_gate)
        self.assertEqual((summary.semantic_cases, summary.semantic_scenarios), (3, 3))

    def test_dimension_gate_needs_fifteen_cases_and_no_safety_error(self):
        def make(index, error_kind=None):
            return EvaluationResult(
                name=f'合成{index}', dimension='subject', expected='auto', actual='auto',
                passed=error_kind is None, subject_ok=error_kind != 'wrong_subject',
                labels_ok=True, expected_subject=None, expected_labels=(),
                facts=(), rejected_count=0, failure_reason=None,
                text_ok=True, validity_ok=True, error_kind=error_kind,
            )

        for factory, expected in (
            (lambda: tuple(make(index) for index in range(14)), False),
            (lambda: tuple(make(index) for index in range(14)) + (make(14, 'general'),), True),
            (lambda: tuple(make(index) for index in range(14)) + (make(14, 'false_fact'),), False),
            (lambda: tuple(make(index) for index in range(14)) + (make(14, 'wrong_subject'),), False),
        ):
            with self.subTest(expected=expected):
                self.assertEqual(summarize(factory())[0].meets_gate, expected)

    def test_expected_labels_detect_reported_completed_action(self):
        case = CASES_BY_NAME["已发生行动"]
        window = build_window(case)
        payload = _payload(window.messages[0].message_id)
        payload.update(speech_act='report', assertion_status='reported')
        model = ToolCallingFakeModel(responses=[_structured_response((payload,))])
        result = baseline_evaluate(case, window, LangChainExtractionRuntime(model=model))
        self.assertEqual(result.actual, 'pending')
        self.assertFalse(result.labels_ok)
        self.assertFalse(result.passed)

    def test_thinking_flag_maps_to_extra_body(self):
        from notalone.memory_extraction.evaluation import _model_options

        self.assertEqual(
            _model_options(thinking=True),
            {"extra_body": {"thinking": {"type": "enabled"}}},
        )
        self.assertEqual(_model_options(thinking=False), {})

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
