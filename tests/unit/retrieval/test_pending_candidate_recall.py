"""待确认候选检索轨的合成行为测试。"""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from uuid import UUID

from notalone.memory import (
    AdoptionMethod,
    InMemoryMemoryStore,
    MemoryCandidate,
    MemoryCategory,
)
from notalone.retrieval import (
    InMemoryRetrieval,
    RetrievedPendingCandidate,
)
from notalone.scopes import ContactScope


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")
CONTACT_ID = UUID("22222222-2222-2222-2222-222222222222")
OTHER_CONTACT_ID = UUID("33333333-3333-3333-3333-333333333333")
SOURCE_ID = UUID("88888888-8888-8888-8888-888888888888")
PENDING_ID = UUID("44444444-4444-4444-4444-444444444444")
SECOND_PENDING_ID = UUID("55555555-5555-5555-5555-555555555555")
REJECTED_ID = UUID("66666666-6666-6666-6666-666666666666")
FOREIGN_ID = UUID("77777777-7777-7777-7777-777777777777")


class RetrievedPendingCandidateContractTest(unittest.TestCase):
    def test_evidence_track_rejects_any_non_pending_status(self) -> None:
        """待确认轨只能承载 pending；已确认资料不能借这条轨进入上下文。"""

        with self.assertRaises(ValueError):
            RetrievedPendingCandidate(
                candidate_id=PENDING_ID,
                scope=ContactScope(OWNER_ID, CONTACT_ID),
                text="合成待确认候选",
                category="preference",
                source_ids=(SOURCE_ID,),
                status="active",
            )

    def test_evidence_track_requires_scope_and_source(self) -> None:
        with self.assertRaises(TypeError):
            RetrievedPendingCandidate(
                candidate_id=PENDING_ID,
                scope="not-a-scope",  # type: ignore[arg-type]
                text="合成待确认候选",
                category="preference",
                source_ids=(SOURCE_ID,),
            )
        with self.assertRaises(ValueError):
            RetrievedPendingCandidate(
                candidate_id=PENDING_ID,
                scope=ContactScope(OWNER_ID, CONTACT_ID),
                text="合成待确认候选",
                category="preference",
                source_ids=(),
            )


class InMemoryPendingCandidateRetrievalTest(unittest.TestCase):
    def setUp(self) -> None:
        self.scope = ContactScope(OWNER_ID, CONTACT_ID)
        self.other_scope = ContactScope(OWNER_ID, OTHER_CONTACT_ID)
        self.store = InMemoryMemoryStore()

    def _candidate(
        self,
        candidate_id: UUID,
        text: str,
        *,
        scope: ContactScope | None = None,
        valid_at: datetime | None = None,
        invalid_at: datetime | None = None,
    ) -> MemoryCandidate:
        candidate = MemoryCandidate(
            candidate_id,
            scope or self.scope,
            text,
            MemoryCategory.PREFERENCE,
            (SOURCE_ID,),
            valid_at=valid_at,
            invalid_at=invalid_at,
        )
        self.store.create_candidate(candidate)
        return candidate

    def _retrieval(self) -> InMemoryRetrieval:
        return InMemoryRetrieval(memory_store=self.store)

    def test_only_pending_candidates_in_current_contact_scope_are_returned(
        self,
    ) -> None:
        self._candidate(PENDING_ID, "对方下个月准备换工作")
        rejected = self._candidate(REJECTED_ID, "对方不喜欢甜食")
        self.store.reject_candidate(scope=self.scope, candidate_id=rejected.candidate_id)
        self._candidate(
            FOREIGN_ID,
            "另一联系人的待确认候选",
            scope=self.other_scope,
        )

        results = self._retrieval().search_pending_candidates(scope=self.scope)

        self.assertEqual(
            tuple(candidate.candidate_id for candidate in results),
            (PENDING_ID,),
        )
        self.assertEqual(results[0].status, "pending")
        self.assertEqual(results[0].scope, self.scope)

    def test_pending_candidates_never_enter_the_confirmed_memory_track(self) -> None:
        self._candidate(PENDING_ID, "对方下个月准备换工作")
        retrieval = self._retrieval()

        self.assertEqual(retrieval.search_confirmed_memories(scope=self.scope), ())
        pending = retrieval.search_pending_candidates(scope=self.scope)
        self.assertEqual(len(pending), 1)

        self.store.confirm(
            scope=self.scope,
            candidate_id=PENDING_ID,
            adoption_method=AdoptionMethod.MANUAL,
        )

        # 确认后只出现在已确认轨：两条轨互不重叠。
        confirmed = retrieval.search_confirmed_memories(scope=self.scope)
        self.assertEqual(
            tuple(memory.text for memory in confirmed),
            ("对方下个月准备换工作",),
        )
        self.assertEqual(retrieval.search_pending_candidates(scope=self.scope), ())

    def test_rejected_candidate_stays_invisible_after_rejection(self) -> None:
        candidate = self._candidate(PENDING_ID, "对方下个月准备换工作")
        retrieval = self._retrieval()
        self.assertEqual(len(retrieval.search_pending_candidates(scope=self.scope)), 1)

        self.store.reject_candidate(
            scope=self.scope,
            candidate_id=candidate.candidate_id,
        )

        self.assertEqual(retrieval.search_pending_candidates(scope=self.scope), ())

    def test_query_scores_candidates_and_respects_limit(self) -> None:
        self._candidate(PENDING_ID, "对方下个月准备换工作")
        self._candidate(SECOND_PENDING_ID, "对方正在考虑养猫")

        results = self._retrieval().search_pending_candidates(
            scope=self.scope,
            query="换工作的事情怎么样了",
            limit=1,
        )

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].candidate_id, PENDING_ID)
        self.assertIsNotNone(results[0].relevance_score)
        self.assertTrue(results[0].matched_terms)

    def test_candidate_ids_only_narrow_to_requested_identifiers(self) -> None:
        self._candidate(PENDING_ID, "对方下个月准备换工作")
        self._candidate(SECOND_PENDING_ID, "对方正在考虑养猫")
        retrieval = self._retrieval()

        matched = retrieval.search_pending_candidates(
            scope=self.scope,
            candidate_ids=(SECOND_PENDING_ID,),
        )
        unknown = retrieval.search_pending_candidates(
            scope=self.scope,
            candidate_ids=(REJECTED_ID,),
        )

        self.assertEqual(
            tuple(candidate.candidate_id for candidate in matched),
            (SECOND_PENDING_ID,),
        )
        self.assertEqual(unknown, ())

    def test_expired_or_not_yet_valid_candidate_is_not_returned(self) -> None:
        now = datetime.now(timezone.utc)
        self._candidate(
            PENDING_ID,
            "上周的计划已经过期",
            invalid_at=now - timedelta(minutes=1),
        )
        self._candidate(
            SECOND_PENDING_ID,
            "下个月才生效的安排",
            valid_at=now + timedelta(days=1),
        )

        self.assertEqual(self._retrieval().search_pending_candidates(scope=self.scope), ())

    def test_expired_still_pending_candidate_is_dropped_by_the_track(self) -> None:
        """store 只按 pending 过滤；有效期与范围由两条检索轨的共享谓词兜住。"""

        now = datetime.now(timezone.utc)
        self._candidate(
            PENDING_ID,
            "上周的计划已经过期",
            invalid_at=now - timedelta(minutes=1),
        )
        self._candidate(
            SECOND_PENDING_ID,
            "下个月才生效的安排",
            valid_at=now + timedelta(days=1),
        )

        # 合成 store 与 PostgreSQL store 一样只按 status 过滤，因此候选仍在。
        self.assertEqual(len(self.store.list_pending_candidates(self.scope)), 2)
        # 检索轨必须把过期与尚未生效的候选挡在回复上下文之外。
        self.assertEqual(
            self._retrieval().search_pending_candidates(scope=self.scope),
            (),
        )

    def test_missing_memory_store_returns_no_pending_candidates(self) -> None:
        self.assertEqual(
            InMemoryRetrieval().search_pending_candidates(scope=self.scope),
            (),
        )

    def test_limit_outside_module_budget_is_rejected(self) -> None:
        retrieval = self._retrieval()

        for limit in (0, 21):
            with self.subTest(limit=limit):
                with self.assertRaises(ValueError):
                    retrieval.search_pending_candidates(
                        scope=self.scope,
                        limit=limit,
                    )


if __name__ == "__main__":
    unittest.main()
