from __future__ import annotations

import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from notalone.experiments.pgvector_adapter import (
    PgVectorCandidateRetrieval,
    VectorHit,
)
from notalone.memory.models import (
    AdoptionMethod,
    ConfirmedMemory,
    ConfirmedMemoryStatus,
    MemoryCategory,
)
from notalone.retrieval.adapters import InMemoryRetrieval
from notalone.scopes import ContactScope


class FakeVectorClient:
    def __init__(self, hits: tuple[VectorHit, ...]) -> None:
        self.hits = hits
        self.calls: list[tuple[ContactScope, str, int]] = []

    def search(self, *, scope: ContactScope, query: str, limit: int):
        self.calls.append((scope, query, limit))
        return self.hits


class StaticMemoryStore:
    def __init__(self, *memories: ConfirmedMemory) -> None:
        self.memories = {memory.memory_id: memory for memory in memories}

    def list_confirmed(self, scope: ContactScope) -> tuple[ConfirmedMemory, ...]:
        return tuple(
            memory
            for memory in self.memories.values()
            if memory.scope == scope and memory.is_retrievable()
        )


def memory(scope: ContactScope, *, text: str, revision: int = 1) -> ConfirmedMemory:
    return ConfirmedMemory(
        memory_id=uuid4(),
        scope=scope,
        text=text,
        category=MemoryCategory.COMMON_FACT,
        source_ids=(uuid4(),),
        source_candidate_id=None,
        adoption_method=AdoptionMethod.MANUAL,
        status=ConfirmedMemoryStatus.ACTIVE,
        revision=revision,
        confidence=0.9,
    )


class PgVectorCandidateRetrievalTest(unittest.TestCase):
    def setUp(self) -> None:
        self.scope = ContactScope(owner_id=uuid4(), contact_id=uuid4())
        self.other_scope = ContactScope(owner_id=uuid4(), contact_id=uuid4())
        self.first = memory(self.scope, text="她喜欢周末散步。")
        self.second = memory(self.scope, text="她周末通常在家休息。")
        self.store = StaticMemoryStore(self.first, self.second)
        self.local = InMemoryRetrieval(memory_store=self.store)

    def test_candidate_is_revalidated_and_sorted_by_similarity(self) -> None:
        client = FakeVectorClient(
            (
                VectorHit(self.second.memory_id, self.scope, 1, 0.91),
                VectorHit(self.first.memory_id, self.scope, 1, 0.95),
            )
        )
        adapter = PgVectorCandidateRetrieval(
            local=self.local, client=client, tau=0.8
        )
        result = adapter.search_confirmed_memories(
            scope=self.scope, query="周末怎么安排？", limit=2
        )
        self.assertEqual(tuple(item.memory_id for item in result), (self.first.memory_id, self.second.memory_id))
        self.assertEqual(result[0].text, self.first.text)
        self.assertEqual(result[0].matched_terms, ())

    def test_foreign_scope_and_stale_revision_are_rejected(self) -> None:
        client = FakeVectorClient(
            (
                VectorHit(self.first.memory_id, self.other_scope, 1, 0.99),
                VectorHit(self.first.memory_id, self.scope, 2, 0.98),
            )
        )
        adapter = PgVectorCandidateRetrieval(
            local=self.local, client=client, tau=0.8
        )
        self.assertEqual(
            adapter.search_confirmed_memories(
                scope=self.scope, query="周末安排？"
            ),
            (),
        )
        self.assertEqual(
            adapter.last_attempt.rejected,
            ((str(self.first.memory_id), "scope"), (str(self.first.memory_id), "revision")),
        )

    def test_deleted_memory_is_rejected_by_local_authority(self) -> None:
        deleted = replace(
            self.second,
            status=ConfirmedMemoryStatus.DELETED,
            invalid_at=datetime.now(timezone.utc),
            revision=2,
        )
        self.store.memories[deleted.memory_id] = deleted
        client = FakeVectorClient(
            (VectorHit(deleted.memory_id, self.scope, 2, 0.99),)
        )
        adapter = PgVectorCandidateRetrieval(
            local=self.local, client=client, tau=0.8
        )
        self.assertEqual(
            adapter.search_confirmed_memories(scope=self.scope, query="周末休息"),
            (),
        )
        self.assertEqual(
            adapter.last_attempt.rejected,
            ((str(deleted.memory_id), "local_authority"),),
        )

    def test_invalidated_and_expired_memories_are_rejected(self) -> None:
        invalidated = replace(
            self.first,
            status=ConfirmedMemoryStatus.INVALIDATED,
            invalid_at=datetime.now(timezone.utc),
            revision=2,
        )
        expired = replace(
            self.second,
            invalid_at=datetime.now(timezone.utc),
            revision=2,
        )
        self.store.memories[invalidated.memory_id] = invalidated
        self.store.memories[expired.memory_id] = expired
        client = FakeVectorClient(
            (
                VectorHit(invalidated.memory_id, self.scope, 2, 0.99),
                VectorHit(expired.memory_id, self.scope, 2, 0.98),
            )
        )
        adapter = PgVectorCandidateRetrieval(
            local=self.local, client=client, tau=0.8
        )
        self.assertEqual(
            adapter.search_confirmed_memories(scope=self.scope, query="周末安排"),
            (),
        )
        self.assertEqual(
            adapter.last_attempt.rejected,
            (
                (str(invalidated.memory_id), "local_authority"),
                (str(expired.memory_id), "local_authority"),
            ),
        )

    def test_duplicate_vector_rows_are_deduplicated(self) -> None:
        client = FakeVectorClient(
            (
                VectorHit(self.first.memory_id, self.scope, 1, 0.91),
                VectorHit(self.first.memory_id, self.scope, 1, 0.95),
            )
        )
        adapter = PgVectorCandidateRetrieval(
            local=self.local, client=client, tau=0.8
        )
        result = adapter.search_confirmed_memories(
            scope=self.scope, query="周末安排", limit=2
        )
        self.assertEqual(tuple(item.memory_id for item in result), (self.first.memory_id,))
        self.assertEqual(adapter.last_attempt.selected_ids, (self.first.memory_id,))

    def test_empty_query_and_explicit_navigation_delegate_without_vector_call(self) -> None:
        client = FakeVectorClient(())
        adapter = PgVectorCandidateRetrieval(local=self.local, client=client, tau=0.8)
        self.assertEqual(adapter.search_confirmed_memories(scope=self.scope, query="!!!"), ())
        self.assertEqual(
            {item.memory_id for item in adapter.search_confirmed_memories(
                scope=self.scope, query=None
            )},
            {self.first.memory_id, self.second.memory_id},
        )
        self.assertEqual(client.calls, [])

    def test_delegated_paths_reset_diagnostics(self) -> None:
        client = FakeVectorClient(
            (VectorHit(self.first.memory_id, self.scope, 1, 0.95),)
        )
        adapter = PgVectorCandidateRetrieval(local=self.local, client=client, tau=0.8)
        adapter.search_confirmed_memories(scope=self.scope, query="周末安排")
        self.assertEqual(adapter.last_attempt.status, "success")
        adapter.search_confirmed_memories(scope=self.scope, query=None)
        self.assertEqual(adapter.last_attempt.status, "delegated")

    def test_malformed_candidates_are_rejected_without_losing_valid_hits(self) -> None:
        client = FakeVectorClient(
            (
                VectorHit(self.first.memory_id, self.scope, "bad", 0.99),  # type: ignore[arg-type]
                VectorHit(self.second.memory_id, self.scope, 1, 0.95),
                object(),  # type: ignore[arg-type]
            )
        )
        adapter = PgVectorCandidateRetrieval(
            local=self.local, client=client, tau=0.8, candidate_limit=3
        )
        result = adapter.search_confirmed_memories(
            scope=self.scope, query="周末安排", limit=2
        )
        self.assertEqual(tuple(item.memory_id for item in result), (self.second.memory_id,))
        self.assertIn((str(self.first.memory_id), "revision"), adapter.last_attempt.rejected)
        self.assertIn(("<unknown>", "mapping"), adapter.last_attempt.rejected)

    def test_memory_not_yet_valid_is_rejected_by_local_authority(self) -> None:
        future = datetime.now(timezone.utc) + timedelta(days=1)
        # 无来源记录已被 ConfirmedMemory 与 RetrievedMemory 的构造校验挡住，
        # 适配器的 source_ids 检查只是防御性兜底，这里验证未来生效时间被拒绝。
        not_yet_valid = replace(self.second, valid_at=future, revision=2)
        self.store.memories[not_yet_valid.memory_id] = not_yet_valid
        client = FakeVectorClient(
            (VectorHit(not_yet_valid.memory_id, self.scope, 2, 0.98),)
        )
        adapter = PgVectorCandidateRetrieval(
            local=self.local, client=client, tau=0.8
        )
        self.assertEqual(
            adapter.search_confirmed_memories(scope=self.scope, query="周末安排"),
            (),
        )
        self.assertEqual(
            adapter.last_attempt.rejected,
            ((str(not_yet_valid.memory_id), "local_authority"),),
        )

    def test_explicit_memory_ids_owner_and_messages_delegate_without_vector_call(self) -> None:
        client = FakeVectorClient(
            (VectorHit(self.first.memory_id, self.scope, 1, 0.99),)
        )
        adapter = PgVectorCandidateRetrieval(local=self.local, client=client, tau=0.8)
        explicit = adapter.search_confirmed_memories(
            scope=self.scope,
            query="周末安排",
            memory_ids=(self.second.memory_id,),
        )
        self.assertEqual(
            tuple(item.memory_id for item in explicit), (self.second.memory_id,)
        )
        self.assertEqual(adapter.last_attempt.status, "delegated")
        self.assertEqual(
            adapter.search_owner_memories(owner_id=self.scope.owner_id, query="聚餐"),
            self.local.search_owner_memories(owner_id=self.scope.owner_id, query="聚餐"),
        )
        self.assertEqual(
            adapter.search_messages(scope=self.scope, query="周末"),
            self.local.search_messages(scope=self.scope, query="周末"),
        )
        self.assertEqual(
            adapter.query_messages(scope=self.scope, anchor_message_id=None),
            self.local.query_messages(scope=self.scope, anchor_message_id=None),
        )
        self.assertEqual(client.calls, [])

    def test_candidate_and_result_limits_require_integers(self) -> None:
        with self.assertRaises(ValueError):
            PgVectorCandidateRetrieval(  # type: ignore[arg-type]
                local=self.local, client=FakeVectorClient(()), tau=0.8, candidate_limit=1.5
            )
        adapter = PgVectorCandidateRetrieval(
            local=self.local, client=FakeVectorClient(()), tau=0.8
        )
        with self.assertRaises(ValueError):
            adapter.search_confirmed_memories(  # type: ignore[arg-type]
                scope=self.scope, query="周末安排", limit=2.5
            )

    def test_client_overflow_is_capped_at_candidate_budget(self) -> None:
        client = FakeVectorClient(
            (
                VectorHit(self.first.memory_id, self.scope, 1, 0.95),
                VectorHit(self.second.memory_id, self.scope, 1, 0.94),
            )
        )
        adapter = PgVectorCandidateRetrieval(
            local=self.local, client=client, tau=0.8, candidate_limit=1
        )
        result = adapter.search_confirmed_memories(
            scope=self.scope, query="周末安排", limit=2
        )
        self.assertEqual(tuple(item.memory_id for item in result), (self.first.memory_id,))
        self.assertIn(("<overflow>", "candidate_limit"), adapter.last_attempt.rejected)


if __name__ == "__main__":
    unittest.main()
