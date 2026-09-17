"""关系记忆评分排序与内存适配器召回的行为测试。"""

from __future__ import annotations

import unittest
from datetime import datetime, timezone
from uuid import UUID

from notalone.memory import (
    AdoptionMethod,
    InMemoryMemoryStore,
    MemoryCandidate,
    MemoryCategory,
)
from notalone.retrieval import (
    InMemoryRetrieval,
    RetrievedMemory,
    RetrievedOwnerMemory,
)
from notalone.retrieval.lexical import build_query_tokens
from notalone.retrieval.ranking import (
    rank_memories,
    recall_memories,
    recall_owner_memories,
)
from notalone.scopes import ContactScope


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")
CONTACT_ID = UUID("22222222-2222-2222-2222-222222222222")
SOURCE_ID = UUID("88888888-8888-8888-8888-888888888888")
SCOPE = ContactScope(OWNER_ID, CONTACT_ID)

QUERY = "周末一起去徒步吗？"


def _memory(
    memory_id: str,
    text: str,
    *,
    adoption_method: str = "auto",
    confidence: float = 1.0,
    valid_at: datetime | None = None,
) -> RetrievedMemory:
    return RetrievedMemory(
        memory_id=UUID(memory_id),
        scope=SCOPE,
        text=text,
        category="preference",
        source_ids=(SOURCE_ID,),
        adoption_method=adoption_method,
        revision=1,
        confidence=confidence,
        valid_at=valid_at,
    )


class RankMemoriesTest(unittest.TestCase):
    def test_scores_and_matched_terms_come_from_shared_scorer(self) -> None:
        relevant = _memory("10000000-0000-0000-0000-000000000001", "对方喜欢徒步")
        irrelevant = _memory("10000000-0000-0000-0000-000000000002", "他最近在忙项目")

        ranked = rank_memories(
            (relevant, irrelevant),
            query_tokens=build_query_tokens(QUERY),
            limit=10,
        )

        self.assertEqual(
            tuple(memory.memory_id for memory in ranked),
            (relevant.memory_id, irrelevant.memory_id),
        )
        self.assertGreater(ranked[0].relevance_score or 0.0, 0.0)
        self.assertIn("徒步", ranked[0].matched_terms)
        self.assertEqual(ranked[1].relevance_score, 0.0)
        self.assertEqual(ranked[1].matched_terms, ())

    def test_higher_relevance_ranks_first(self) -> None:
        weak = _memory("10000000-0000-0000-0000-000000000003", "徒步")
        strong = _memory(
            "10000000-0000-0000-0000-000000000004",
            "对方周末喜欢徒步",
        )

        ranked = rank_memories(
            (weak, strong),
            query_tokens=build_query_tokens(QUERY),
            limit=10,
        )

        self.assertEqual(ranked[0].memory_id, strong.memory_id)

    def test_manual_confirmation_wins_on_equal_relevance(self) -> None:
        auto = _memory(
            "10000000-0000-0000-0000-000000000005",
            "对方喜欢徒步",
            adoption_method="auto",
        )
        manual = _memory(
            "10000000-0000-0000-0000-000000000006",
            "对方喜欢徒步",
            adoption_method="manual",
        )

        ranked = rank_memories(
            (auto, manual),
            query_tokens=build_query_tokens(QUERY),
            limit=10,
        )

        self.assertEqual(ranked[0].memory_id, manual.memory_id)

    def test_higher_confidence_wins_on_equal_relevance_and_adoption(self) -> None:
        low = _memory(
            "10000000-0000-0000-0000-000000000007",
            "对方喜欢徒步",
            confidence=0.6,
        )
        high = _memory(
            "10000000-0000-0000-0000-000000000008",
            "对方喜欢徒步",
            confidence=0.9,
        )

        ranked = rank_memories(
            (low, high),
            query_tokens=build_query_tokens(QUERY),
            limit=10,
        )

        self.assertEqual(ranked[0].memory_id, high.memory_id)

    def test_newer_valid_at_wins_and_missing_valid_at_ranks_last(self) -> None:
        older = _memory(
            "10000000-0000-0000-0000-000000000009",
            "对方喜欢徒步",
            valid_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        newer = _memory(
            "10000000-0000-0000-0000-00000000000a",
            "对方喜欢徒步",
            valid_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
        )
        missing = _memory("10000000-0000-0000-0000-00000000000b", "对方喜欢徒步")

        ranked = rank_memories(
            (older, missing, newer),
            query_tokens=build_query_tokens(QUERY),
            limit=10,
        )

        self.assertEqual(
            tuple(memory.memory_id for memory in ranked),
            (newer.memory_id, older.memory_id, missing.memory_id),
        )

    def test_memory_id_breaks_remaining_ties(self) -> None:
        first = _memory("10000000-0000-0000-0000-00000000000c", "对方喜欢徒步")
        second = _memory("10000000-0000-0000-0000-00000000000d", "对方喜欢徒步")

        ranked = rank_memories(
            (second, first),
            query_tokens=build_query_tokens(QUERY),
            limit=10,
        )

        self.assertEqual(ranked[0].memory_id, first.memory_id)

    def test_limit_keeps_ranking_prefix(self) -> None:
        memories = tuple(
            _memory(
                f"10000000-0000-0000-0000-00000000001{index}",
                "对方喜欢徒步",
            )
            for index in range(4)
        )

        ranked = rank_memories(
            memories,
            query_tokens=build_query_tokens(QUERY),
            limit=2,
        )

        self.assertEqual(len(ranked), 2)
        self.assertEqual(ranked[0].memory_id, memories[0].memory_id)
        self.assertEqual(ranked[1].memory_id, memories[1].memory_id)

    def test_input_memories_are_not_mutated(self) -> None:
        memory = _memory("10000000-0000-0000-0000-00000000000e", "对方喜欢徒步")

        rank_memories(
            (memory,),
            query_tokens=build_query_tokens(QUERY),
            limit=10,
        )

        self.assertIsNone(memory.relevance_score)

    def test_invalid_inputs_are_rejected(self) -> None:
        with self.assertRaises(TypeError):
            rank_memories(
                "not-tuple",  # type: ignore[arg-type]
                query_tokens=build_query_tokens(QUERY),
                limit=10,
            )
        with self.assertRaises(TypeError):
            rank_memories(
                ("not-memory",),  # type: ignore[arg-type]
                query_tokens=build_query_tokens(QUERY),
                limit=10,
            )
        with self.assertRaises(ValueError):
            rank_memories((), query_tokens=build_query_tokens(QUERY), limit=0)


class RecallMemoriesTest(unittest.TestCase):
    def test_query_none_keeps_revalidation_semantics(self) -> None:
        memories = (
            _memory("10000000-0000-0000-0000-000000000020", "对方喜欢徒步"),
            _memory("10000000-0000-0000-0000-000000000021", "他最近在忙项目"),
        )

        recalled = recall_memories(memories, query=None, limit=5)

        self.assertEqual(recalled, memories)
        self.assertTrue(all(memory.relevance_score is None for memory in recalled))

    def test_query_without_tokens_returns_nothing(self) -> None:
        memories = (
            _memory("10000000-0000-0000-0000-000000000022", "对方喜欢徒步"),
        )

        for query in ("", "   ", "😀😀", "。。"):
            with self.subTest(query=query):
                self.assertEqual(
                    recall_memories(memories, query=query, limit=5),
                    (),
                )

    def test_query_scores_and_ranks_candidates(self) -> None:
        memories = (
            _memory("10000000-0000-0000-0000-000000000023", "他最近在忙项目"),
            _memory("10000000-0000-0000-0000-000000000024", "对方喜欢徒步"),
        )

        recalled = recall_memories(memories, query=QUERY, limit=5)

        self.assertEqual(recalled[0].memory_id, memories[1].memory_id)
        self.assertGreater(recalled[0].relevance_score or 0.0, 0.0)

    def test_non_string_query_is_rejected(self) -> None:
        with self.assertRaises(TypeError):
            recall_memories((), query=123, limit=5)  # type: ignore[arg-type]


def _owner_memory(
    memory_id: str,
    text: str,
    *,
    owner_id: UUID = OWNER_ID,
    adoption_method: str = "manual",
    confidence: float = 1.0,
    valid_at: datetime | None = None,
) -> RetrievedOwnerMemory:
    return RetrievedOwnerMemory(
        memory_id=UUID(memory_id),
        owner_id=owner_id,
        text=text,
        category="preference",
        topic="other",
        source_ids=(SOURCE_ID,),
        adoption_method=adoption_method,
        revision=1,
        confidence=confidence,
        valid_at=valid_at,
    )


class OwnerRecallTest(unittest.TestCase):
    def test_query_none_keeps_revalidation_semantics(self) -> None:
        memories = (
            _owner_memory("10000000-0000-0000-0000-000000000030", "我明天有空"),
        )

        recalled = recall_owner_memories(memories, query=None, limit=5)

        self.assertEqual(recalled, memories)
        self.assertTrue(all(memory.relevance_score is None for memory in recalled))

    def test_query_without_tokens_returns_nothing(self) -> None:
        memories = (
            _owner_memory("10000000-0000-0000-0000-000000000031", "我明天有空"),
        )

        for query in ("", "   ", "😀"):
            with self.subTest(query=query):
                self.assertEqual(
                    recall_owner_memories(memories, query=query, limit=5),
                    (),
                )

    def test_query_scores_and_ranks_owner_memories(self) -> None:
        work = _owner_memory("10000000-0000-0000-0000-000000000032", "我最近在忙项目")
        hiking = _owner_memory("10000000-0000-0000-0000-000000000033", "我喜欢周末徒步")

        recalled = recall_owner_memories((work, hiking), query=QUERY, limit=5)

        self.assertEqual(recalled[0].memory_id, hiking.memory_id)
        self.assertGreater(recalled[0].relevance_score or 0.0, 0.0)
        self.assertEqual(recalled[1].relevance_score, 0.0)

    def test_higher_confidence_wins_on_equal_relevance(self) -> None:
        low = _owner_memory(
            "10000000-0000-0000-0000-000000000034",
            "我喜欢周末徒步",
            confidence=0.6,
        )
        high = _owner_memory(
            "10000000-0000-0000-0000-000000000035",
            "我喜欢周末徒步",
            confidence=0.9,
        )

        recalled = recall_owner_memories((low, high), query=QUERY, limit=5)

        self.assertEqual(recalled[0].memory_id, high.memory_id)

    def test_non_string_query_is_rejected(self) -> None:
        with self.assertRaises(TypeError):
            recall_owner_memories((), query=123, limit=5)  # type: ignore[arg-type]


class InMemoryOwnerRecallTest(unittest.TestCase):
    def _retrieval(self) -> InMemoryRetrieval:
        return InMemoryRetrieval(
            owner_memories=(
                _owner_memory("30000000-0000-0000-0000-000000000011", "我明天有空"),
                _owner_memory("30000000-0000-0000-0000-000000000012", "我最近在忙项目"),
            ),
        )

    def test_query_returns_scored_owner_memory(self) -> None:
        retrieval = self._retrieval()

        results = retrieval.search_owner_memories(
            owner_id=OWNER_ID,
            query="明天一起吃饭吗？",
        )

        self.assertEqual(results[0].text, "我明天有空")
        self.assertGreater(results[0].relevance_score or 0.0, 0.0)

    def test_owner_isolation_and_memory_ids_filter(self) -> None:
        retrieval = self._retrieval()

        self.assertEqual(
            retrieval.search_owner_memories(
                owner_id=UUID("99999999-9999-9999-9999-999999999999"),
                query="明天一起吃饭吗？",
            ),
            (),
        )
        filtered = retrieval.search_owner_memories(
            owner_id=OWNER_ID,
            query=None,
            memory_ids=(UUID("30000000-0000-0000-0000-000000000012"),),
        )
        self.assertEqual(
            tuple(memory.text for memory in filtered),
            ("我最近在忙项目",),
        )

    def test_invalid_query_type_is_rejected(self) -> None:
        retrieval = self._retrieval()

        with self.assertRaises(TypeError):
            retrieval.search_owner_memories(
                owner_id=OWNER_ID,
                query=123,  # type: ignore[arg-type]
            )


class InMemoryRecallTest(unittest.TestCase):
    def _retrieval(self) -> tuple[InMemoryRetrieval, tuple[UUID, UUID]]:
        store = InMemoryMemoryStore()
        memory_ids: list[UUID] = []
        fixtures = (
            ("30000000-0000-0000-0000-000000000001", "对方喜欢徒步"),
            ("30000000-0000-0000-0000-000000000002", "他最近在忙项目"),
        )
        for candidate_id, text in (
            (UUID(candidate_id), text) for candidate_id, text in fixtures
        ):
            store.create_candidate(
                MemoryCandidate(
                    candidate_id,
                    SCOPE,
                    text,
                    MemoryCategory.PREFERENCE,
                    (SOURCE_ID,),
                )
            )
            memory = store.confirm(
                scope=SCOPE,
                candidate_id=candidate_id,
                adoption_method=AdoptionMethod.MANUAL,
            )
            memory_ids.append(memory.memory_id)
        return InMemoryRetrieval(
            memory_store=store,  # type: ignore[arg-type]
        ), (memory_ids[0], memory_ids[1])

    def test_query_returns_scored_ranking_with_relevant_memory_first(self) -> None:
        retrieval, (hiking_id, work_id) = self._retrieval()

        results = retrieval.search_confirmed_memories(scope=SCOPE, query=QUERY)

        self.assertEqual(results[0].memory_id, hiking_id)
        self.assertGreater(results[0].relevance_score or 0.0, 0.0)
        self.assertIn("徒步", results[0].matched_terms)
        self.assertEqual(results[1].memory_id, work_id)
        self.assertEqual(results[1].relevance_score, 0.0)

    def test_query_none_skips_scoring_and_keeps_store_order(self) -> None:
        retrieval, (hiking_id, work_id) = self._retrieval()

        results = retrieval.search_confirmed_memories(scope=SCOPE, query=None)

        self.assertEqual(
            tuple(memory.memory_id for memory in results),
            (hiking_id, work_id),
        )
        self.assertTrue(all(memory.relevance_score is None for memory in results))

    def test_tokenless_query_returns_no_candidates(self) -> None:
        retrieval, _ = self._retrieval()

        self.assertEqual(
            retrieval.search_confirmed_memories(scope=SCOPE, query="😀😀"),
            (),
        )

    def test_memory_ids_revalidation_filter_still_applies(self) -> None:
        retrieval, (_, work_id) = self._retrieval()

        results = retrieval.search_confirmed_memories(
            scope=SCOPE,
            query=QUERY,
            memory_ids=(work_id,),
        )

        self.assertEqual(
            tuple(memory.memory_id for memory in results),
            (work_id,),
        )

    def test_invalid_query_type_is_rejected(self) -> None:
        retrieval, _ = self._retrieval()

        with self.assertRaises(TypeError):
            retrieval.search_confirmed_memories(
                scope=SCOPE,
                query=123,  # type: ignore[arg-type]
            )


if __name__ == "__main__":
    unittest.main()
