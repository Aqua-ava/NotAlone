"""记忆召回评测的 CI 门槛测试（无需模型凭据与数据库）。"""

from __future__ import annotations

import unittest

from notalone.retrieval.recall_cases import (
    CASES,
    DIMENSIONS,
    MIN_CASES_PER_DIMENSION,
    RecallCase,
    RecallMemoryCase,
)
from notalone.retrieval.recall_evaluation import (
    GATE_BUDGET_HIT_RATE,
    GATE_DIRECT_HIT_RATE,
    GATE_ORDER_RATE,
    GATE_PARAPHRASE_HIT_RATE,
    GATE_SAFETY_VIOLATIONS,
    RecallCaseResult,
    RecallDimensionSummary,
    evaluate_case,
    summarize,
)


class RecallEvaluationGateTest(unittest.TestCase):
    results: tuple[RecallCaseResult, ...]
    summaries: dict[str, RecallDimensionSummary]

    @classmethod
    def setUpClass(cls) -> None:
        cls.results = tuple(evaluate_case(case) for case in CASES)
        cls.summaries = {
            summary.dimension: summary for summary in summarize(cls.results)
        }

    def test_every_dimension_has_enough_cases(self) -> None:
        for dimension in DIMENSIONS:
            with self.subTest(dimension=dimension):
                self.assertGreaterEqual(
                    self.summaries[dimension].cases,
                    MIN_CASES_PER_DIMENSION,
                )

    def test_direct_hit_rate_meets_gate(self) -> None:
        summary = self.summaries["direct"]
        self.assertGreaterEqual(
            summary.hit_rate,
            GATE_DIRECT_HIT_RATE,
            msg=self._failures("direct"),
        )

    def test_paraphrase_hit_rate_meets_gate(self) -> None:
        summary = self.summaries["paraphrase"]
        self.assertGreaterEqual(
            summary.hit_rate,
            GATE_PARAPHRASE_HIT_RATE,
            msg=self._failures("paraphrase"),
        )

    def test_safety_dimensions_have_no_violations(self) -> None:
        for dimension in ("irrelevant", "isolation", "invalid"):
            with self.subTest(dimension=dimension):
                self.assertEqual(
                    self.summaries[dimension].unexpected,
                    GATE_SAFETY_VIOLATIONS,
                    msg=self._failures(dimension),
                )

    def test_budget_dimension_meets_gate(self) -> None:
        summary = self.summaries["budget"]
        self.assertEqual(summary.over_budget, 0, msg=self._failures("budget"))
        self.assertGreaterEqual(
            summary.hit_rate,
            GATE_BUDGET_HIT_RATE,
            msg=self._failures("budget"),
        )

    def test_ordering_rate_meets_gate(self) -> None:
        summary = self.summaries["ordering"]
        self.assertGreaterEqual(
            summary.order_rate,
            GATE_ORDER_RATE,
            msg=self._failures("ordering"),
        )

    def test_all_dimensions_meet_gate(self) -> None:
        failed = [
            summary.dimension
            for summary in self.summaries.values()
            if not summary.meets_gate
        ]
        self.assertEqual(failed, [], msg=self._failures(*failed))

    def test_failing_case_is_attributable(self) -> None:
        case = RecallCase(
            name="门槛自检",
            dimension="direct",
            query="周末一起去徒步吗？",
            memories=(RecallMemoryCase("对方喜欢徒步"),),
            expect_recalled=("不存在的记忆",),
        )

        result = evaluate_case(case)

        self.assertFalse(result.passed)
        self.assertIn("缺少预期记忆", result.failure_reason)
        self.assertEqual(result.dimension, "direct")

    def _failures(self, *dimensions: str) -> str:
        lines = []
        for result in self.results:
            if dimensions and result.dimension not in dimensions:
                continue
            if not result.passed:
                lines.append(f"{result.name}: {result.failure_reason}")
        return "\n".join(lines) or "无失败用例"


if __name__ == "__main__":
    unittest.main()
