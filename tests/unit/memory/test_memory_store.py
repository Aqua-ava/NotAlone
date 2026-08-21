"""关系记忆生命周期的合成行为测试。"""

from __future__ import annotations

import unittest
from uuid import UUID

from notalone.memory import (
    AdoptionMethod,
    InMemoryMemoryStore,
    MemoryCandidate,
    MemoryCategory,
    MemoryCandidateStatus,
)
from notalone.retrieval import InMemoryRetrieval
from notalone.scopes import ContactScope


OWNER_ID = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
CONTACT_ID = UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
OTHER_CONTACT_ID = UUID("cccccccc-cccc-cccc-cccc-cccccccccccc")
CANDIDATE_ID = UUID("dddddddd-dddd-dddd-dddd-dddddddddddd")
SOURCE_ID = UUID("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee")


class MemoryStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.scope = ContactScope(OWNER_ID, CONTACT_ID)
        self.other_scope = ContactScope(OWNER_ID, OTHER_CONTACT_ID)
        self.store = InMemoryMemoryStore()

    def _candidate(self, *, scope: ContactScope | None = None) -> MemoryCandidate:
        return MemoryCandidate(
            candidate_id=CANDIDATE_ID,
            scope=scope or self.scope,
            text="对方喜欢徒步",
            category=MemoryCategory.PREFERENCE,
            source_ids=(SOURCE_ID,),
        )

    def test_pending_candidate_is_not_retrieved_until_confirmed(self) -> None:
        self.store.create_candidate(self._candidate())
        retrieval = InMemoryRetrieval(memory_store=self.store)

        self.assertEqual(
            retrieval.search_confirmed_memories(scope=self.scope),
            (),
        )

        confirmed = self.store.confirm(
            scope=self.scope,
            candidate_id=CANDIDATE_ID,
            adoption_method=AdoptionMethod.MANUAL,
        )
        self.assertEqual(confirmed.text, "对方喜欢徒步")
        self.assertEqual(
            retrieval.search_confirmed_memories(scope=self.scope)[0].text,
            "对方喜欢徒步",
        )

    def test_correction_invalidation_and_deletion_change_later_retrieval(self) -> None:
        self.store.create_candidate(self._candidate())
        confirmed = self.store.confirm(
            scope=self.scope,
            candidate_id=CANDIDATE_ID,
        )
        retrieval = InMemoryRetrieval(memory_store=self.store)

        corrected = self.store.correct(
            scope=self.scope,
            memory_id=confirmed.memory_id,
            text="对方最近喜欢城市徒步",
        )
        self.assertEqual(corrected.revision, confirmed.revision + 1)
        self.assertEqual(
            retrieval.search_confirmed_memories(scope=self.scope)[0].text,
            "对方最近喜欢城市徒步",
        )

        self.store.invalidate(scope=self.scope, memory_id=confirmed.memory_id)
        self.assertEqual(
            retrieval.search_confirmed_memories(scope=self.scope),
            (),
        )

        self.store.delete(scope=self.scope, memory_id=confirmed.memory_id)
        self.assertEqual(
            retrieval.search_confirmed_memories(scope=self.scope),
            (),
        )

    def test_scope_is_checked_when_creating_and_mutating_memory(self) -> None:
        self.store.create_candidate(self._candidate(scope=self.other_scope))
        with self.assertRaises(PermissionError):
            self.store.confirm(
                scope=self.scope,
                candidate_id=CANDIDATE_ID,
            )

    def test_candidate_state_is_explicit(self) -> None:
        candidate = self.store.create_candidate(self._candidate())
        self.assertEqual(candidate.status, MemoryCandidateStatus.PENDING)

    def test_candidate_can_be_rejected_or_invalidated_before_confirmation(self) -> None:
        rejected = self.store.create_candidate(self._candidate())
        rejected = self.store.reject_candidate(
            scope=self.scope,
            candidate_id=rejected.candidate_id,
        )
        self.assertEqual(rejected.status, MemoryCandidateStatus.REJECTED)
        with self.assertRaises(RuntimeError):
            self.store.confirm(scope=self.scope, candidate_id=CANDIDATE_ID)

        other_candidate_id = UUID("ffffffff-ffff-ffff-ffff-ffffffffffff")
        invalidated = self.store.create_candidate(
            MemoryCandidate(
                candidate_id=other_candidate_id,
                scope=self.scope,
                text="对方最近在加班",
                category=MemoryCategory.RECENT_STATE,
                source_ids=(SOURCE_ID,),
            )
        )
        invalidated = self.store.invalidate_candidate(
            scope=self.scope,
            candidate_id=invalidated.candidate_id,
        )
        self.assertEqual(invalidated.status, MemoryCandidateStatus.INVALIDATED)
        with self.assertRaises(RuntimeError):
            self.store.confirm(scope=self.scope, candidate_id=other_candidate_id)


if __name__ == "__main__":
    unittest.main()
