"""待确认候选共享谓词的合成行为测试。

内存适配器与 PostgreSQL 适配器共用
``notalone.retrieval.pending.select_current_pending_candidates``。这里直接
验证「pending + 同范围 + 有效期（半开区间）+ 来源可用」四个条件，以及
来源核验失败必须 fail closed。
"""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from uuid import UUID

from notalone.memory import MemoryCandidate, MemoryCandidateStatus, MemoryCategory
from notalone.retrieval.errors import RetrievalInvariantError
from notalone.retrieval.pending import select_current_pending_candidates
from notalone.scopes import ContactScope


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")
CONTACT_ID = UUID("22222222-2222-2222-2222-222222222222")
OTHER_CONTACT_ID = UUID("33333333-3333-3333-3333-333333333333")
SOURCE_ID = UUID("88888888-8888-8888-8888-888888888888")
SECOND_SOURCE_ID = UUID("99999999-9999-9999-9999-999999999999")
PENDING_ID = UUID("44444444-4444-4444-4444-444444444444")
SECOND_PENDING_ID = UUID("55555555-5555-5555-5555-555555555555")


class PendingCandidatePredicateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.scope = ContactScope(OWNER_ID, CONTACT_ID)
        self.now = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)

    def _candidate(
        self,
        candidate_id: UUID = PENDING_ID,
        *,
        scope: ContactScope | None = None,
        status: MemoryCandidateStatus = MemoryCandidateStatus.PENDING,
        valid_at: datetime | None = None,
        invalid_at: datetime | None = None,
        source_ids: tuple[UUID, ...] = (SOURCE_ID,),
    ) -> MemoryCandidate:
        return MemoryCandidate(
            candidate_id=candidate_id,
            scope=scope or self.scope,
            text="对方下个月准备换工作",
            category=MemoryCategory.PREFERENCE,
            source_ids=source_ids,
            status=status,
            valid_at=valid_at,
            invalid_at=invalid_at,
        )

    def _select(
        self,
        candidates,
        *,
        candidate_ids: tuple[UUID, ...] | None = None,
        available_source_ids=None,
    ) -> tuple[MemoryCandidate, ...]:
        return select_current_pending_candidates(
            candidates,
            scope=self.scope,
            now=self.now,
            candidate_ids=candidate_ids,
            available_source_ids=available_source_ids,
        )

    def test_only_pending_candidates_in_scope_are_selected(self) -> None:
        pending = self._candidate()
        confirmed = self._candidate(
            SECOND_PENDING_ID,
            status=MemoryCandidateStatus.CONFIRMED,
        )
        foreign = self._candidate(
            candidate_id=UUID("66666666-6666-6666-6666-666666666666"),
            scope=ContactScope(OWNER_ID, OTHER_CONTACT_ID),
        )

        self.assertEqual(self._select((pending, confirmed, foreign)), (pending,))

    def test_validity_window_is_half_open(self) -> None:
        just_started = self._candidate(valid_at=self.now)
        already_ended = self._candidate(
            SECOND_PENDING_ID,
            invalid_at=self.now,
        )
        future = self._candidate(
            candidate_id=UUID("77777777-7777-7777-7777-777777777777"),
            valid_at=self.now + timedelta(seconds=1),
        )
        expired = self._candidate(
            candidate_id=UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
            invalid_at=self.now - timedelta(seconds=1),
        )

        selected = self._select((just_started, already_ended, future, expired))

        self.assertEqual(selected, (just_started,))

    def test_candidate_ids_only_narrow_the_result(self) -> None:
        first = self._candidate()
        second = self._candidate(SECOND_PENDING_ID)

        self.assertEqual(
            self._select((first, second), candidate_ids=(SECOND_PENDING_ID,)),
            (second,),
        )
        self.assertEqual(self._select((first, second), candidate_ids=()), ())

    def test_source_reader_is_asked_once_for_the_union_of_sources(self) -> None:
        first = self._candidate()
        second = self._candidate(
            SECOND_PENDING_ID,
            source_ids=(SOURCE_ID, SECOND_SOURCE_ID),
        )
        calls: list[tuple[UUID, ...]] = []

        def available(source_ids: tuple[UUID, ...]) -> frozenset[UUID]:
            calls.append(source_ids)
            return frozenset({SOURCE_ID})

        selected = self._select(
            (first, second),
            available_source_ids=available,
        )

        self.assertEqual(selected, (first, second))
        self.assertEqual(calls, [(SOURCE_ID, SECOND_SOURCE_ID)])

    def test_candidate_without_any_available_source_is_dropped(self) -> None:
        available_candidate = self._candidate()
        unavailable_candidate = self._candidate(
            SECOND_PENDING_ID,
            source_ids=(SECOND_SOURCE_ID,),
        )

        selected = self._select(
            (available_candidate, unavailable_candidate),
            available_source_ids=lambda source_ids: frozenset({SOURCE_ID}),
        )

        self.assertEqual(selected, (available_candidate,))

    def test_source_reader_is_not_called_without_candidates(self) -> None:
        calls: list[tuple[UUID, ...]] = []

        def available(source_ids: tuple[UUID, ...]) -> frozenset[UUID]:
            calls.append(source_ids)
            return frozenset(source_ids)

        self.assertEqual(self._select((), available_source_ids=available), ())
        self.assertEqual(calls, [])

    def test_source_reader_failure_is_not_swallowed(self) -> None:
        def failing(source_ids: tuple[UUID, ...]) -> frozenset[UUID]:
            raise RuntimeError("synthetic source verification failure")

        with self.assertRaises(RuntimeError):
            self._select((self._candidate(),), available_source_ids=failing)

    def test_invalid_source_reader_result_is_rejected(self) -> None:
        def invalid(source_ids: tuple[UUID, ...]) -> frozenset[UUID]:
            return frozenset({"not-a-uuid"})  # type: ignore[arg-type]

        with self.assertRaises(RetrievalInvariantError):
            self._select((self._candidate(),), available_source_ids=invalid)

    def test_without_source_reader_no_source_filtering_happens(self) -> None:
        candidate = self._candidate(source_ids=(SECOND_SOURCE_ID,))

        self.assertEqual(self._select((candidate,)), (candidate,))


if __name__ == "__main__":
    unittest.main()
