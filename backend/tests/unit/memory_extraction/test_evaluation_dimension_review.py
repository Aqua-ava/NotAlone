"""逐轴汇总只接收独立审核，不让旧matcher覆盖原始安全错误。"""

import unittest
from dataclasses import replace

from notalone.memory_extraction.evaluation import evaluate_outcome, summarize
from notalone.memory_extraction.evaluation_cases import EvaluationCase
from tests.unit.memory_extraction.test_evaluation_review import _evidence


class DimensionReviewTest(unittest.TestCase):
    def data(self):
        original = evaluate_outcome(
            EvaluationCase("合成原件安全", "reference", (("contact", "已读完"),), (0,), "auto"),
            _evidence()["final_facts"], verification_enabled=True,
        )
        axes = {name: {"status": "pass", "basis": f"独立核对{name}"}
                for name in ("subject", "time", "truth_intent", "paraphrase", "reference", "media", "reported")}
        return original, axes

    def test_only_the_independently_failed_axis_gets_a_general_error(self):
        from notalone.memory_extraction.evaluation_review import dimension_results_from_review

        original = evaluate_outcome(
            EvaluationCase("合成逐轴审核", "reference", (("contact", "已读完"),), (0,), "pending"),
            _evidence()["final_facts"], verification_enabled=True,
        )
        self.assertFalse(original.passed)
        axes = {name: {"status": "fail" if name == "reference" else "pass", "basis": f"独立核对{name}"}
                for name in ("subject", "time", "truth_intent", "paraphrase", "reference", "media", "reported")}
        results = dimension_results_from_review(
            original, axes, decision="safe", safety={"raw_false_fact": 0, "raw_wrong_person": 0,
                "false_fact": 0, "wrong_person": 0}, semantic_case_id="a" * 64,
        )
        by_axis = {item.dimension: item for item in results}
        self.assertEqual(len(by_axis), 7)
        self.assertEqual(by_axis["reference"].error_kind, "general")
        self.assertFalse(by_axis["reference"].passed)
        self.assertTrue(by_axis["media"].passed)
        self.assertEqual(by_axis["media"].facts, original.facts)

    def test_raw_and_final_safety_errors_cannot_be_hidden_by_axis_pass_or_pending(self):
        from notalone.memory_extraction.evaluation_review import dimension_results_from_review

        original, axes = self.data()
        original = replace(original, actual="pending", passed=True)
        results = dimension_results_from_review(
            original, axes, decision="safety_error", safety={"raw_false_fact": 2, "raw_wrong_person": 1,
                "false_fact": 1, "wrong_person": 1}, semantic_case_id="b" * 64,
        )
        for result, summary in zip(results, summarize(results), strict=True):
            self.assertFalse(result.passed)
            self.assertEqual(result.false_fact_count, 2)
            self.assertEqual(result.wrong_subject_count, 1)
            self.assertEqual(set(result.error_kinds), {"false_fact", "wrong_subject"})
            self.assertFalse(summary.meets_gate)
        self.assertTrue(all(summary.false_facts == 2 and summary.wrong_subjects == 1
                            for summary in summarize(results)))

    def test_global_missing_contract_is_general_for_every_axis(self):
        from notalone.memory_extraction.evaluation_review import dimension_results_from_review

        original, axes = self.data()
        results = dimension_results_from_review(
            original, axes, decision="general_error", safety={"raw_false_fact": 0, "raw_wrong_person": 0,
                "false_fact": 0, "wrong_person": 0}, semantic_case_id="c" * 64,
        )
        self.assertTrue(all(not result.passed and result.error_kind == "general" for result in results))

    def test_missing_or_unresolved_axis_cannot_produce_countable_results(self):
        from notalone.memory_extraction.evaluation_review import dimension_results_from_review

        original, axes = self.data()
        safety = {"raw_false_fact": 0, "raw_wrong_person": 0, "false_fact": 0, "wrong_person": 0}
        axes["reference"]["status"] = "unresolved"
        with self.assertRaisesRegex(ValueError, "review_dimensions_unresolved"):
            dimension_results_from_review(original, axes, decision="safe", safety=safety, semantic_case_id="d" * 64)
        axes.pop("reference")
        with self.assertRaises(ValueError):
            dimension_results_from_review(original, axes, decision="safe", safety=safety, semantic_case_id="d" * 64)


if __name__ == "__main__":
    unittest.main()
