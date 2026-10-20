"""关系记忆生命周期的合成行为测试。"""

from __future__ import annotations

import unittest
from dataclasses import replace
from datetime import datetime, timezone
from uuid import UUID

from notalone.memory import (
    AdoptionMethod,
    InMemoryMemoryStore,
    MemoryCandidate,
    MemoryCategory,
    MemoryCandidateStatus,
    MemoryTiming,
)
from notalone.retrieval import InMemoryRetrieval
from notalone.scopes import ContactScope
from notalone.memory.versions import MemoryVersionConflict


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

    def test_corrected_error_remains_auditable_but_cannot_be_retrieved_as_history(self):
        self.store.create_candidate(self._candidate())
        original = self.store.confirm(scope=self.scope, candidate_id=CANDIDATE_ID,
                                      adoption_method=AdoptionMethod.MANUAL)
        current = self.store.correct(scope=self.scope, memory_id=original.memory_id,
                                     text="对方不喜欢徒步")
        versions = self.store.list_versions(scope=self.scope, memory_id=current.memory_id)
        self.assertIn(original.text, [item.text for item in versions])
        retrieval = InMemoryRetrieval(memory_store=self.store)
        self.assertEqual(retrieval.search_confirmed_memories(
            scope=self.scope, memory_ids=(original.memory_id,), include_historical=True), ())
        self.assertEqual(retrieval.search_confirmed_memories(scope=self.scope)[0].text,
                         "对方不喜欢徒步")

    def test_deleting_current_version_withdraws_its_historical_chain(self):
        self.store.create_candidate(self._candidate())
        original = self.store.confirm(scope=self.scope, candidate_id=CANDIDATE_ID,
                                      adoption_method=AdoptionMethod.MANUAL)
        current = self.store.correct(scope=self.scope, memory_id=original.memory_id,
                                     text="对方后来不喜欢徒步", change_kind="state_changed")
        retrieval = InMemoryRetrieval(memory_store=self.store)
        self.assertEqual(retrieval.search_confirmed_memories(
            scope=self.scope, memory_ids=(original.memory_id,), include_historical=True), ())
        self.assertIn(original.text, [item.text for item in self.store.list_versions(
            scope=self.scope, memory_id=current.memory_id)])
        with self.assertRaises(MemoryVersionConflict):
            self.store.delete(scope=self.scope, memory_id=original.memory_id)
        self.store.delete(scope=self.scope, memory_id=current.memory_id)
        self.assertEqual(retrieval.search_confirmed_memories(
            scope=self.scope, memory_ids=(original.memory_id,), include_historical=True), ())

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

    def test_save_confirm_and_correct_use_their_own_time_without_changing_source_dates(self):
        historical = datetime(2020, 3, 1, tzinfo=timezone.utc)
        candidate = self.store.create_candidate(replace(
            self._candidate(),
            timing=MemoryTiming.from_source_times((historical,), recorded_at=historical),
        ))
        confirmed = self.store.confirm(scope=self.scope, candidate_id=CANDIDATE_ID)
        corrected = self.store.correct(scope=self.scope, memory_id=confirmed.memory_id, text="合成历史资料修正")
        for record in (candidate, confirmed, corrected):
            self.assertEqual(record.timing.source_started_at, historical)
            self.assertEqual(record.timing.source_ended_at, historical)
            self.assertTrue(record.timing.source_time_complete)
        self.assertGreater(candidate.timing.recorded_at, historical)
        self.assertGreaterEqual(confirmed.timing.recorded_at, candidate.timing.recorded_at)
        self.assertGreater(corrected.timing.recorded_at, confirmed.timing.recorded_at)

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

        self.store.delete(scope=self.scope, memory_id=corrected.memory_id)
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

    def test_candidate_keeps_interpretation_explanations_through_lifecycle(self) -> None:
        candidate = self.store.create_candidate(replace(
            self._candidate(),
            alternatives=("也可能是临时安排", "也可能只是转述"),
            interpretation_reason="消息使用了将来时，且没有明确完成事实。",
        ))

        self.assertEqual(candidate.alternatives, ("也可能是临时安排", "也可能只是转述"))
        self.assertEqual(candidate.interpretation_reason, "消息使用了将来时，且没有明确完成事实。")

        confirmed = self.store.confirm(
            scope=self.scope,
            candidate_id=candidate.candidate_id,
        )
        stored_candidate = self.store.get_candidate(
            scope=self.scope,
            candidate_id=candidate.candidate_id,
        )
        self.assertEqual(stored_candidate.status, MemoryCandidateStatus.CONFIRMED)
        self.assertEqual(stored_candidate.alternatives, candidate.alternatives)
        self.assertEqual(stored_candidate.interpretation_reason, candidate.interpretation_reason)
        self.assertEqual(confirmed.text, candidate.text)

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
