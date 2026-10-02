"""有限严格 oracle 的合成正反候选通过公开评测入口验证。"""
from dataclasses import replace
import unittest

from notalone.memory_extraction.evaluation import build_window, evaluate_case, summarize
from notalone.memory_extraction.semantic_evaluation_cases import (
    SEMANTIC_CHALLENGES,
    challenge_payloads,
)
from tests.unit.memory_extraction.test_flow import RecordingRuntime


class SemanticEvaluationCasesTest(unittest.TestCase):
    def test_controlled_pairs_are_faithful_or_deliberately_unsupported(self):
        self.assertGreaterEqual(len(SEMANTIC_CHALLENGES), 15)
        self.assertEqual(len({challenge.case.messages for challenge in SEMANTIC_CHALLENGES}),
                         len(SEMANTIC_CHALLENGES))
        for challenge in SEMANTIC_CHALLENGES:
            window = build_window(challenge.case)
            for variant, expected_pass in (("good", True), ("bad", False)):
                with self.subTest(case=challenge.case.name, variant=variant):
                    result = evaluate_case(challenge.case, window, RecordingRuntime(
                        challenge_payloads(challenge, window, variant=variant)
                    ), baseline=True)
                    self.assertEqual(result.passed, expected_pass)
                    self.assertTrue(result.semantic_annotated)
                    self.assertFalse(result.verification_enabled)
                    if expected_pass:
                        self.assertTrue(all(result.claims_recalled))
                        self.assertEqual(result.unmatched_candidates, ())
                    else:
                        self.assertGreater(result.false_fact_count, 0)

    def test_second_faithful_paraphrases_are_not_exact_text_answers(self):
        paraphrases = (
            ("联系人滴酒不沾。",),
            ("联系人从来不喝牛奶。", "联系人早饭饮用豆浆。"),
            ("联系人有时徒步。",),
            ("联系人家中有2只猫。", "联系人没养狗。"),
            ("联系人购得2张展览门票。",),
            ("联系人如果明天不降雨就去露营。",),
            ("用户仅周三现场办公，其余工作日都远程办公。",),
            ("据联系人说，联系人的姐姐在苏州当设计师。", "联系人在无锡负责仓库管理。"),
            ("据联系人说，老陈居住在天津。", "联系人住重庆。"),
            ("用户本周一到周三临时在南区值班。",),
            ("联系人去年春天学会游泳，不是今年。",),
            ("双方原计划周六去看展览已取消了。",),
            ("联系人当前在南京工作。", "联系人下个月打算去青岛培训。"),
            ("联系人平时偏爱红茶。", "联系人下周准备去厦门参加展会。"),
            ("用户在宁波博物馆从事讲解工作，已经工作3年了。",),
        )
        self.assertEqual(len(paraphrases), len(SEMANTIC_CHALLENGES))
        for challenge, texts in zip(SEMANTIC_CHALLENGES, paraphrases):
            with self.subTest(case=challenge.case.name):
                window = build_window(challenge.case)
                payloads = challenge_payloads(challenge, window, variant="good")
                self.assertEqual(len(texts), len(payloads))
                result = evaluate_case(challenge.case, window, RecordingRuntime(tuple(
                    {**payload, "text": text} for payload, text in zip(payloads, texts)
                )), baseline=True)
                self.assertTrue(result.passed)

    def test_original_cases_are_preserved_and_coverage_is_explicit(self):
        from notalone.memory_extraction.evaluation_cases import CASES
        self.assertEqual(len(CASES), 120)
        self.assertEqual(sum(case.expected_claims is not None for case in CASES), 20)
        self.assertTrue(all(challenge.case.expected_claims is not None
                            for challenge in SEMANTIC_CHALLENGES))

    def test_faithful_complete_compound_recalls_each_allowed_claim(self):
        for challenge, text in (
            (SEMANTIC_CHALLENGES[1], "联系人从来不喝牛奶，早餐喝豆浆。"),
            (SEMANTIC_CHALLENGES[3], "联系人家里养了两只猫，没有养狗。"),
        ):
            with self.subTest(case=challenge.case.name):
                window = build_window(challenge.case)
                payload = challenge_payloads(challenge, window, variant="good")[0]
                result = evaluate_case(challenge.case, window, RecordingRuntime((
                    {**payload, "text": text},
                )), baseline=True)
                self.assertTrue(result.passed)
                self.assertEqual(result.claims_recalled, (True, True))
                self.assertEqual(result.false_fact_count, 0)
                appended = evaluate_case(challenge.case, window, RecordingRuntime((
                    {**payload, "text": text[:-1] + "，联系人每天喝白酒。"},
                )), baseline=True)
                self.assertFalse(appended.passed)
                self.assertEqual(appended.false_fact_count, 1)

    def test_markers_in_separate_candidates_do_not_recall_one_claim(self):
        challenge = SEMANTIC_CHALLENGES[-1]
        window = build_window(challenge.case)
        payload = challenge_payloads(challenge, window, variant="good")[0]
        result = evaluate_case(challenge.case, window, RecordingRuntime((
            {**payload, "text": "用户在宁波博物馆担任讲解员。"},
            {**payload, "text": "用户已工作三年。"},
        )), baseline=True)
        self.assertFalse(result.passed)
        self.assertEqual(result.claims_recalled, (False,))
        self.assertEqual(result.false_fact_count, 2)

    def test_all_expected_claims_need_recall(self):
        challenge = SEMANTIC_CHALLENGES[12]
        window = build_window(challenge.case)
        result = evaluate_case(challenge.case, window, RecordingRuntime(
            challenge_payloads(challenge, window, variant="good")[:1]
        ), baseline=True)
        self.assertEqual(result.actual, "auto")
        self.assertEqual(result.claims_recalled, (True, False))
        self.assertFalse(result.passed)
        self.assertEqual(result.error_kind, "general")

    def test_candidate_destinations_cannot_be_hidden_by_group_maximum(self):
        challenge = SEMANTIC_CHALLENGES[12]
        window = build_window(challenge.case)
        current, planned = challenge_payloads(challenge, window, variant="good")
        result = evaluate_case(challenge.case, window, RecordingRuntime((
            current, {**planned, "speech_act": "assertion"},
        )), baseline=True)
        self.assertEqual(result.actual, "auto")
        self.assertFalse(result.destination_ok)
        self.assertFalse(result.passed)
        self.assertEqual(result.false_fact_count, 1)

    def test_unannotated_and_repeated_scenarios_do_not_meet_semantic_gate(self):
        challenge = SEMANTIC_CHALLENGES[0]
        results = []
        for index in range(15):
            case = replace(challenge.case, name=f"重复源场景{index}")
            window = build_window(case)
            results.append(evaluate_case(case, window, RecordingRuntime(
                challenge_payloads(challenge, window, variant="good")
            ), baseline=True))
        summary = summarize(results)[0]
        self.assertEqual(summary.semantic_cases, 15)
        self.assertEqual(summary.semantic_scenarios, 1)
        self.assertFalse(summary.meets_gate)
        unlabeled = tuple(replace(result, semantic_annotated=False, semantic_case_id=None)
                          for result in results)
        self.assertEqual(summarize(unlabeled)[0].semantic_cases, 0)
        self.assertFalse(summarize(unlabeled)[0].meets_gate)


if __name__ == "__main__":
    unittest.main()
