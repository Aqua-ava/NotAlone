"""检索评测与向量开关的合成测试。"""

from __future__ import annotations

import unittest
from notalone.retrieval import (
    InMemoryRetrieval,
    ReplyEvaluationObservation,
    RetrievalFeatureFlags,
    build_synthetic_retrieval_fixture,
    evaluate_retrieval,
)


class FailingRetrieval:
    def search_messages(self, **kwargs: object) -> tuple[object, ...]:
        raise RuntimeError("synthetic backend failure")


class LeakyRetrieval:
    def __init__(self, message: object) -> None:
        self.message = message

    def search_messages(self, **kwargs: object) -> tuple[object, ...]:
        return (self.message,)


class RetrievalEvaluationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = build_synthetic_retrieval_fixture()

    def test_synthetic_fixture_covers_required_categories_and_metrics(self) -> None:
        report = evaluate_retrieval(
            InMemoryRetrieval(messages=self.fixture.messages),
            self.fixture.cases,
            adapter_name="synthetic-in-memory",
        )

        self.assertEqual(report.metrics.case_count, 6)
        self.assertEqual(
            {case.category for case in self.fixture.cases},
            {
                "synonym_expression",
                "exact_phrase",
                "time_window",
                "no_result",
                "conflict",
                "cross_contact",
            },
        )
        self.assertEqual(report.metrics.empty_result_rate.numerator, 2)
        self.assertEqual(report.metrics.empty_result_rate.denominator, 6)
        self.assertEqual(report.metrics.top_k_hit_rate.numerator, 5)
        self.assertEqual(report.metrics.top_k_hit_rate.denominator, 6)
        self.assertGreater(report.metrics.retrieval_query_tokens, 0)
        self.assertEqual(report.metrics.tool_calls, 0)
        self.assertEqual(report.metrics.citation_correction_rate.denominator, 0)
        self.assertEqual(report.metrics.candidate_rejection_rate.denominator, 0)
        self.assertEqual(
            report.vector_recommendation,
            "re_evaluate_before_vector",
        )
        self.assertFalse(report.vector_enabled)

        serialized = report.as_dict()
        self.assertNotIn("周末一起吃饭", report.to_json())
        self.assertEqual(serialized["coverage"]["categories"]["conflict"], 1)
        self.assertEqual(
            serialized["observations"][0]["case_id"],
            "synonym-expression",
        )
        self.assertIn("引用纠错率 | N/A", report.to_markdown())

    def test_reply_observations_record_citation_rejection_tokens_and_tools(
        self,
    ) -> None:
        observations = tuple(
            ReplyEvaluationObservation(
                case_id=self.fixture.cases[index].case_id,
                citation_corrected=index == 0,
                candidate_rejected=index == 1,
                latency_ms=10 + index,
                input_tokens=100 + index,
                output_tokens=20 + index,
                tool_calls=index,
            )
            for index in range(2)
        )
        report = evaluate_retrieval(
            InMemoryRetrieval(messages=self.fixture.messages),
            self.fixture.cases,
            reply_observations=observations,
        )

        self.assertEqual(report.metrics.citation_correction_rate.numerator, 1)
        self.assertEqual(report.metrics.citation_correction_rate.denominator, 2)
        self.assertEqual(report.metrics.candidate_rejection_rate.numerator, 1)
        self.assertEqual(report.metrics.candidate_rejection_rate.denominator, 2)
        self.assertEqual(report.metrics.reply_input_tokens, 201)
        self.assertEqual(report.metrics.reply_output_tokens, 41)
        self.assertEqual(report.metrics.tool_calls, 1)
        self.assertEqual(report.metrics.reply_latency_ms.sample_count, 2)

    def test_retrieval_failure_can_be_measured_as_safe_fallback(self) -> None:
        case = self.fixture.cases[1]
        expected = next(
            message
            for message in self.fixture.messages
            if message.message_id in case.expected_message_ids
        )
        report = evaluate_retrieval(
            FailingRetrieval(),
            (case,),
            fallback=lambda current_case: (expected,)
            if current_case.case_id == case.case_id
            else (),
        )

        self.assertEqual(report.observations[0].status, "fallback")
        self.assertTrue(report.observations[0].fallback_used)
        self.assertEqual(report.metrics.fallback_rate.value, 1.0)
        self.assertTrue(report.observations[0].top_k_hit)

    def test_cross_contact_result_is_a_failed_evaluation(self) -> None:
        case = self.fixture.cases[-1]
        foreign = next(
            message
            for message in self.fixture.messages
            if message.scope == self.fixture.other_scope
        )

        report = evaluate_retrieval(LeakyRetrieval(foreign), (case,))

        self.assertEqual(report.observations[0].status, "failed")
        self.assertEqual(
            report.observations[0].failure_kind,
            "cross_contact_result",
        )

    def test_vector_is_disabled_without_all_safety_proofs(self) -> None:
        self.assertFalse(RetrievalFeatureFlags().vector_candidates_enabled)
        self.assertFalse(
            RetrievalFeatureFlags(
                vector_candidates_requested=True,
                vector_privacy_reviewed=True,
            ).vector_candidates_enabled
        )

        with self.assertRaises(ValueError):
            evaluate_retrieval(
                InMemoryRetrieval(messages=self.fixture.messages),
                self.fixture.cases,
                feature_flags=RetrievalFeatureFlags(
                    vector_candidates_requested=True,
                    vector_privacy_reviewed=True,
                    vector_provider_configured=True,
                ),
            )
        self.assertTrue(
            RetrievalFeatureFlags(
                vector_candidates_requested=True,
                vector_privacy_reviewed=True,
                vector_provider_configured=True,
            ).vector_candidates_enabled
        )
        self.assertFalse(
            RetrievalFeatureFlags.from_environment(
                {
                    "NOTALONE_RETRIEVAL_VECTOR_ENABLED": "true",
                    "NOTALONE_RETRIEVAL_VECTOR_PRIVACY_REVIEWED": "true",
                }
            ).vector_candidates_enabled
        )


if __name__ == "__main__":
    unittest.main()
