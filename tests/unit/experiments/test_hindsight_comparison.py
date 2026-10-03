"""通过真实 Context 接缝核对校准门和完整尝试统计。"""

from dataclasses import replace
import unittest

from notalone.experiments.hindsight_baseline import build_fixture
from notalone.experiments.hindsight_calibration import (
    calibrate,
    evaluate_arm,
    latency_summary,
)
from notalone.experiments.hindsight_client import (
    RecallBatch,
    RecallHit,
    bank_id_for,
    document_id_for,
)
from notalone.experiments.hindsight_dataset import build_dataset


class HindsightComparisonTests(unittest.TestCase):
    def test_dev_calibration_keeps_positive_and_rejects_irrelevant_context(
        self,
    ) -> None:
        dataset = build_dataset()
        positive = next(
            q for q in dataset.queries if q.query_id == "dev-photo-paraphrase-1"
        )
        empty = next(q for q in dataset.queries if q.query_id == "dev-empty-1")
        gold = next(
            m for m in dataset.memories if m.memory_id == positive.contact_gold[0]
        )
        negative = next(
            m
            for m in dataset.memories
            if m.scope == gold.scope and m.role == "topic_negative"
        )
        positive = replace(positive, contact_gold=(gold.memory_id,))
        dataset = replace(dataset, memories=(gold, negative), queries=(positive, empty))

        def hit(memory, score):
            return RecallHit(
                str(memory.memory_id),
                None,
                document_id_for(memory.memory_id),
                {
                    "local_memory_id": str(memory.memory_id),
                    "owner_id": str(memory.scope.owner_id),
                    "contact_id": str(memory.scope.contact_id),
                    "layer": "confirmed_memory",
                    "revision": "1",
                },
                score,
                score,
            )

        class SyntheticService:
            def recall(self, *, bank_id: str, query: str) -> RecallBatch:
                values = (
                    (hit(negative, 0.2),)
                    if query == empty.text
                    else (hit(gold, 0.4), hit(negative, 0.2))
                )
                unmapped = RecallHit(
                    "graph-unmapped",
                    None,
                    document_id_for(gold.memory_id),
                    {},
                    1.0,
                    1.0,
                )
                return RecallBatch(
                    bank_id, (*values, unmapped), True, "仅用于接缝测试的外部替身"
                )

        result = calibrate(build_fixture(dataset), SyntheticService())
        self.assertEqual(result["tau_B"], 0.4)
        self.assertEqual(result["selected_summary"]["macro_recall_at_5"], 1.0)
        self.assertEqual(result["selected_summary"]["irrelevant_injection_queries"], 0)
        self.assertIn(
            ("graph-unmapped", "mapping"),
            result["selected_attempts"][0]["diagnostics"]["rejected"],
        )

    def test_dev_timeout_is_retained_and_prevents_parameter_acceptance(self) -> None:
        dataset = build_dataset()
        query = next(
            q for q in dataset.queries if q.query_id == "dev-photo-paraphrase-1"
        )
        dataset = replace(dataset, queries=(query,))

        class UnavailableService:
            def recall(self, *, bank_id: str, query: str) -> RecallBatch:
                raise TimeoutError("合成服务等待失败")

        result = calibrate(build_fixture(dataset), UnavailableService())
        self.assertFalse(result["prerequisites_met"])
        self.assertIsNone(result["tau_B"])
        self.assertEqual(
            result["captured_http_attempts"][0]["result"]["status"], "failed"
        )
        self.assertEqual(result["captured_http_attempts"][0]["http_attempts"], 1)

    def test_all_attempt_p95_includes_timeout_instead_of_fast_successes_only(
        self,
    ) -> None:
        dataset = build_dataset()
        query = next(q for q in dataset.queries if q.query_id == "final-coffee-direct")
        attempt = evaluate_arm(build_fixture(dataset), query)
        trials = tuple(
            replace(attempt, result=replace(attempt.result, elapsed_ms=float(n)))
            for n in range(1, 95)
        )
        failed = replace(
            attempt,
            result=replace(
                attempt.result,
                status="failed",
                error="TimeoutError",
                elapsed_ms=1500.0,
                contact_selected=(),
                owner_selected=(),
            ),
        )
        summary = latency_summary((*trials, *(failed for _ in range(6))))
        self.assertEqual(summary["all_attempts"]["p95_ms"], 1500.0)
        self.assertEqual(summary["successful_attempts"]["p95_ms"], 90.0)
        self.assertEqual(summary["timeout_failures"], 6)


if __name__ == "__main__":
    unittest.main()
