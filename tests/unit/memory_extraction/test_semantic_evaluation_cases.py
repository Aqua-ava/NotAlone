"""有限严格 oracle 的合成正反候选通过公开评测入口验证。"""
from dataclasses import replace
from typing import Literal
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
        variants: tuple[tuple[Literal["good", "bad"], bool], ...] = (("good", True), ("bad", False))
        for challenge in SEMANTIC_CHALLENGES:
            window = build_window(challenge.case)
            for variant, expected_pass in variants:
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
        original_challenges = SEMANTIC_CHALLENGES[:15]
        self.assertEqual(len(paraphrases), len(original_challenges))
        for challenge, texts in zip(original_challenges, paraphrases):
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
        self.assertEqual(len(CASES), 123)
        self.assertEqual(sum(case.expected_claims is not None for case in CASES), 20)
        self.assertTrue(all(challenge.case.expected_claims is not None
                            for challenge in SEMANTIC_CHALLENGES))

    def test_short_lived_cases_require_an_expiry_and_long_lived_ones_forbid_it(self):
        """短期类型必须带失效时间，长期事实必须留空，两类都要有用例固定。"""

        from notalone.memory_extraction.evaluation_cases import CASES
        by_name = {case.name: case for case in CASES}
        for name in ("短期：次日日程", "短期：当天瞬时状态", "临时借住", "出差中"):
            with self.subTest(name=name):
                case = by_name[name]
                self.assertEqual(case.dimension, "time")
                self.assertIs(case.expect_valid_at, True)
                self.assertIs(case.expect_invalid_at, True)
        for name in ("长期：稳定习惯留空有效期", "固定习惯", "上个月旅行"):
            with self.subTest(name=name):
                case = by_name[name]
                self.assertEqual(case.dimension, "time")
                self.assertIs(case.expect_invalid_at, False)

    def test_time_cases_do_not_reuse_the_prompt_example_sentences_verbatim(self):
        """用例句子不得与提示词内联举例逐字重复，否则分不清泛化规则与示例记忆。"""

        from notalone.memory_extraction.adapters import EXTRACTION_SYSTEM_PROMPT
        from notalone.memory_extraction.evaluation_cases import CASES
        by_name = {case.name: case for case in CASES}
        transient = by_name["短期：当天瞬时状态"]
        long_lived = by_name["长期：稳定习惯留空有效期"]
        self.assertEqual(len(transient.messages), 1)
        self.assertEqual(len(long_lived.messages), 1)
        transient_text = transient.messages[0][1]
        long_lived_text = long_lived.messages[0][1]
        # 瞬时状态不得复述提示词里的"还没吃饭"举例，长期事实保持留空口径。
        self.assertNotIn("还没吃饭", transient_text)
        self.assertNotIn(transient_text.rstrip("。"), EXTRACTION_SYSTEM_PROMPT)
        self.assertNotIn(long_lived_text.rstrip("。"), EXTRACTION_SYSTEM_PROMPT)
        self.assertTrue(transient.note)
        self.assertTrue(long_lived.note)
        # 两条用例仍必须可判别：瞬时状态给失效时间，长期事实留空。
        self.assertIs(transient.expect_invalid_at, True)
        self.assertIs(long_lived.expect_invalid_at, False)

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
        challenge = next(challenge for challenge in SEMANTIC_CHALLENGES
                         if challenge.case.name == "严格：明确职业正向")
        window = build_window(challenge.case)
        payload = challenge_payloads(challenge, window, variant="good")[0]
        result = evaluate_case(challenge.case, window, RecordingRuntime((
            {**payload, "text": "用户在宁波博物馆担任讲解员。"},
            {**payload, "text": "用户已工作三年。"},
        )), baseline=True)
        self.assertFalse(result.passed)
        self.assertEqual(result.claims_recalled, (False,))
        self.assertEqual(result.false_fact_count, 2)

    def test_price_opinion_and_conditional_inquiry_do_not_become_enrollment(self):
        challenge = next((challenge for challenge in SEMANTIC_CHALLENGES
                          if challenge.case.name == "严格：报价判断与条件咨询"), None)
        self.assertIsNotNone(challenge, "缺少报价判断与条件咨询的公开回归场景。")
        assert challenge is not None
        window = build_window(challenge.case)
        opinion, undecided, inquiry = challenge_payloads(challenge, window, variant="good")
        paraphrases = (
            {**opinion, "text": "用户觉得泥塑体验课两次90元挺合适。"},
            {**undecided, "text": "用户还没决定要不要报名泥塑体验课。"},
            {**inquiry, "text": "用户只有周末有空才去询问场地能否借工具。"},
        )
        result = evaluate_case(challenge.case, window, RecordingRuntime(paraphrases), baseline=True)
        self.assertTrue(result.passed)
        self.assertEqual(result.claims_recalled, (True, True, True))
        self.assertEqual(tuple(fact["destination"] for fact in result.facts),
                         ("auto", "auto", "pending"))
        compound = evaluate_case(challenge.case, window, RecordingRuntime((
            {**opinion, "text": "用户认为两次泥塑体验课90元合适，但尚未决定是否报名。"},
            inquiry,
        )), baseline=True)
        self.assertTrue(compound.passed)
        self.assertEqual(compound.claims_recalled, (True, True, True))
        for replacement, index in (
            ({**opinion, "text": "用户认为两次泥塑体验课90元合适，并已决定报名。"}, 0),
            ({**inquiry, "text": "用户周末一定去咨询场地是否能借工具。"}, 2),
            ({**inquiry, "text": "用户仅在周末有空时去借用场地工具。"}, 2),
        ):
            with self.subTest(text=replacement["text"]):
                payloads = [opinion, undecided, inquiry]
                payloads[index] = replacement
                bad = evaluate_case(challenge.case, window, RecordingRuntime(tuple(payloads)),
                                    baseline=True)
                self.assertFalse(bad.passed)
                self.assertIn(index, bad.unmatched_candidates)

    def test_third_party_history_and_speakers_known_unknown_keep_roles_and_labels(self):
        challenge = next((challenge for challenge in SEMANTIC_CHALLENGES
                          if challenge.case.name == "严格：第三人历史经历与当前未知"), None)
        self.assertIsNotNone(challenge, "缺少第三人历史经历与当前未知的公开回归场景。")
        assert challenge is not None
        window = build_window(challenge.case)
        history, unknown = challenge_payloads(challenge, window, variant="good")
        result = evaluate_case(challenge.case, window, RecordingRuntime((
            {**history, "text": "据联系人说，联系人的表弟2024年暑假曾负责社区读书会的活动主持。"},
            {**unknown, "text": "联系人不清楚其表弟现在从事什么职业。"},
        )), baseline=True)
        self.assertTrue(result.passed)
        self.assertEqual(result.claims_recalled, (True, True))
        self.assertEqual(tuple(fact["destination"] for fact in result.facts), ("pending", "auto"))
        for replacement, index in (
            ({**history, "text": "联系人2024年暑假曾在社区读书会负责活动主持。"}, 0),
            ({**history, "subject": "self"}, 0),
            ({**history, "speech_act": "assertion", "assertion_status": "asserted"}, 0),
            ({**history, "text": "联系人的表弟目前在社区读书会负责活动主持。"}, 0),
            ({**history, "text": "联系人的表弟2024年暑假曾在社区读书会负责活动主持，目前也从事这份工作。"}, 0),
            ({**unknown, "text": "联系人不知道自己目前做什么工作。"}, 1),
            ({**unknown, "assertion_status": "unknown"}, 1),
        ):
            with self.subTest(candidate=replacement):
                payloads = [history, unknown]
                payloads[index] = replacement
                bad = evaluate_case(challenge.case, window, RecordingRuntime(tuple(payloads)),
                                    baseline=True)
                self.assertFalse(bad.passed)
                self.assertIn(index, bad.unmatched_candidates)

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

    def test_semantic_coverage_is_reported_separately_from_the_gate(self):
        challenge = SEMANTIC_CHALLENGES[0]
        results = []
        for index in range(15):
            case = replace(challenge.case, name=f"重复源场景{index}")
            window = build_window(case)
            results.append(evaluate_case(case, window, RecordingRuntime(
                challenge_payloads(challenge, window, variant="good")
            ), baseline=True))
        summary = summarize(results)[0]
        # 达标签按 ADR-027 第 2 条；标注覆盖只作为单独字段如实报告：
        # 同一个来源场景重复 15 次时 scenarios=1，但不再把门槛压成永假。
        self.assertEqual(summary.cases, 15)
        self.assertEqual(summary.semantic_cases, 15)
        self.assertEqual(summary.semantic_scenarios, 1)
        self.assertEqual((summary.false_facts, summary.wrong_subjects), (0, 0))
        self.assertTrue(summary.meets_gate)
        unlabeled = tuple(replace(result, semantic_annotated=False, semantic_case_id=None)
                          for result in results)
        unlabeled_summary = summarize(unlabeled)[0]
        self.assertEqual(unlabeled_summary.semantic_cases, 0)
        self.assertEqual(unlabeled_summary.semantic_scenarios, 0)
        self.assertTrue(unlabeled_summary.meets_gate)


if __name__ == "__main__":
    unittest.main()
