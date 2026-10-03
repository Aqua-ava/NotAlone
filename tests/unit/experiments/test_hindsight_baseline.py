"""通过实验 runner 观察真实 Context 的选入和当前性。"""

from dataclasses import replace
import unittest
from uuid import UUID

from notalone.reply.context import ReplyContext

from notalone.experiments.hindsight_baseline import (
    FixtureHandles,
    build_fixture,
    evaluate_query,
)
from notalone.experiments.hindsight_dataset import build_dataset
from notalone.retrieval.adapters import InMemoryRetrieval
from notalone.retrieval.models import RetrievedMemory
from notalone.scopes import ContactScope


class HindsightBaselineTests(unittest.TestCase):
    def test_initial_port_failure_is_not_misreported_as_successful_empty_recall(
        self,
    ) -> None:
        class UnavailableExternalPort(InMemoryRetrieval):
            def search_confirmed_memories(
                self,
                *,
                scope: ContactScope,
                query: str | None = None,
                limit: int = 20,
                memory_ids: tuple[UUID, ...] | None = None,
            ) -> tuple[RetrievedMemory, ...]:
                raise TimeoutError("合成外部服务超时")

        dataset = build_dataset()
        query = next(q for q in dataset.queries if q.query_id == "final-coffee-direct")
        result = evaluate_query(
            build_fixture(dataset),
            query,
            retrieval_factory=lambda local: UnavailableExternalPort(
                messages=local.messages,
                memory_store=local.memory_store,
                owner_memories=local.owner_memories,
            ),
        )
        self.assertEqual(result.status, "failed")
        self.assertEqual(result.contact_selected, ())
        self.assertTrue(result.contact_gold)

    def test_direct_query_selects_gold_with_authoritative_ids(self) -> None:
        dataset = build_dataset()
        query = next(q for q in dataset.queries if q.query_id == "final-coffee-direct")
        # 接缝纵切用两条已标注正例；完整 bank 的质量由报告观察，不强迫 A 零误注入。
        query = replace(query, contact_gold=query.contact_gold[:2])
        dataset = replace(
            dataset,
            memories=tuple(
                m for m in dataset.memories if m.memory_id in query.contact_gold
            ),
            queries=(query,),
        )
        result = evaluate_query(build_fixture(dataset), query)
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(
            {item.identity.memory_id for item in result.contact_selected},
            set(query.contact_gold),
        )

    def test_deletion_after_selection_is_failure_and_keeps_positive_denominator(
        self,
    ) -> None:
        from notalone.experiments.hindsight_metrics import summarize_results

        dataset = build_dataset()
        query = next(q for q in dataset.queries if q.query_id == "final-coffee-direct")
        fixture = build_fixture(dataset)

        def delete_selected(handles: FixtureHandles, context: ReplyContext) -> None:
            for item in context.evidence:
                if item.kind == "confirmed_memory":
                    handles.memory_store.delete(
                        scope=item.scope, memory_id=item.evidence_id
                    )
                    break

        result = evaluate_query(fixture, query, before_validate=delete_selected)
        self.assertEqual(result.status, "failed")
        self.assertEqual(result.contact_selected, ())
        summary = summarize_results((result,))
        self.assertEqual(summary["positive_queries"], 1)
        self.assertEqual(summary["macro_recall_at_5"], 0.0)

    def test_identical_text_in_other_scopes_never_enters_final_context(self) -> None:
        dataset = build_dataset()
        query = next(q for q in dataset.queries if q.group == "isolation")
        result = evaluate_query(build_fixture(dataset), query)
        self.assertEqual(result.status, "succeeded")
        self.assertTrue(
            set(query.contact_gold).issubset(
                {item.identity.memory_id for item in result.contact_selected}
            )
        )
        self.assertEqual(result.scope_violations, 0)
        foreign = {m.memory_id for m in dataset.memories if m.role == "scope_negative"}
        self.assertTrue(
            foreign.isdisjoint(
                item.identity.memory_id for item in result.contact_selected
            )
        )

    def test_owner_budget_is_independent_of_contact_budget(self) -> None:
        dataset = build_dataset()
        query = next(q for q in dataset.queries if q.group == "owner_budget")
        result = evaluate_query(build_fixture(dataset), query)
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(len(result.owner_selected), 3)
        self.assertFalse(result.over_budget)
        self.assertLessEqual(sum(len(m.text) for m in result.owner_selected), 240)


if __name__ == "__main__":
    unittest.main()
