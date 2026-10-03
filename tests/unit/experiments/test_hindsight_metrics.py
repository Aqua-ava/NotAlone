"""指标的独立算例：同文不同 ID、空结果和失败不能合并或丢弃。"""

from dataclasses import replace
import unittest
from uuid import UUID

from notalone.experiments.hindsight_metrics import (
    MemoryIdentity,
    QueryResult,
    SelectedMemory,
    summarize_results,
)


class HindsightMetricsTests(unittest.TestCase):
    def test_id_scoring_and_failed_positive_have_known_denominators(self) -> None:
        owner = UUID(int=1)
        contact = UUID(int=2)
        gold1 = MemoryIdentity("contact", owner, contact, UUID(int=3))
        gold2 = MemoryIdentity("contact", owner, contact, UUID(int=4))
        unrelated = MemoryIdentity("contact", owner, contact, UUID(int=5))
        result = QueryResult(
            "positive",
            "final",
            "paraphrase",
            "succeeded",
            None,
            1.0,
            "start",
            "finish",
            (gold1, gold2),
            (),
            (
                SelectedMemory(gold1, "相同正文", (), 1, ""),
                SelectedMemory(unrelated, "相同正文", (), 1, ""),
            ),
            (),
        )
        failed = replace(
            result, query_id="failed", status="failed", contact_selected=()
        )
        summary = summarize_results((result, failed))
        self.assertEqual(summary["macro_recall_at_5"], 0.25)
        self.assertEqual(summary["macro_precision_at_5"], 0.5)
        self.assertEqual(summary["irrelevant_injection_query_rate"], 0.5)
        self.assertEqual(summary["positive_empty_rate"], 0.5)
        self.assertEqual(summary["positive_queries"], 2)
        self.assertEqual(summary["failed_queries"], 1)


if __name__ == "__main__":
    unittest.main()
