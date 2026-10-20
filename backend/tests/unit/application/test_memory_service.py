"""记忆管理服务的单测；使用内存 fake 端口，不触碰数据库。"""

from __future__ import annotations

import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from notalone.application.memory_service import (
    ManualMemoryEntry,
    MemoryService,
)
from notalone.memory.models import (
    AdoptionMethod,
    ConfirmedMemory,
    ConfirmedMemoryStatus,
    MemoryCandidate,
    MemoryCategory,
    MemoryChangeKind,
    MemoryTopic,
    OwnerMemory,
)
from notalone.memory.adapters import InMemoryMemoryStore
from notalone.memory_extraction.adoption import MemoryAdoption
from notalone.memory_extraction.flow import ExtractionOutcome
from notalone.memory_extraction.models import (
    AssertionStatus,
    ExtractedFact,
    FactSubject,
    FigurativeType,
    SpeechAct,
)
from notalone.scopes import ContactScope


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")
CONTACT_ID = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")


def _scope() -> ContactScope:
    return ContactScope(owner_id=OWNER_ID, contact_id=CONTACT_ID)


class FakeContactMemory:
    def __init__(self) -> None:
        self.candidates: list[MemoryCandidate] = []
        self.memories: list[ConfirmedMemory] = []
        self.confirm_calls: list[tuple[ContactScope, UUID, AdoptionMethod]] = []
        self.reject_calls: list[tuple[ContactScope, UUID]] = []
        self.discard_calls: list[tuple[ContactScope, UUID]] = []
        self.correct_calls: list[tuple[ContactScope, UUID, str, MemoryCategory | None]] = []
        self.delete_calls: list[tuple[ContactScope, UUID]] = []

    def create_candidate(self, candidate: MemoryCandidate) -> MemoryCandidate:
        self.candidates.append(candidate)
        return candidate

    def create_manual_candidate(self, candidate: MemoryCandidate) -> MemoryCandidate:
        self.candidates.append(candidate)
        return candidate

    def list_pending_candidates(self, scope: ContactScope) -> tuple[MemoryCandidate, ...]:
        return tuple(
            candidate
            for candidate in self.candidates
            if candidate.status.value == "pending" and candidate.scope == scope
        )

    def get_candidate(
        self,
        *,
        scope: ContactScope,
        candidate_id: UUID,
    ) -> MemoryCandidate:
        return next(
            candidate
            for candidate in self.candidates
            if candidate.scope == scope and candidate.candidate_id == candidate_id
        )

    def list_confirmed(self, scope: ContactScope, *, include_expired: bool = False, include_invalidated: bool = False) -> tuple[ConfirmedMemory, ...]:
        return tuple(
            memory
            for memory in self.memories
            if memory.scope == scope
            and (memory.status is ConfirmedMemoryStatus.ACTIVE
                 or (include_invalidated and memory.status is ConfirmedMemoryStatus.INVALIDATED))
        )

    def confirm(
        self,
        *,
        scope: ContactScope,
        candidate_id: UUID,
        adoption_method: AdoptionMethod = AdoptionMethod.AUTO,
    ) -> ConfirmedMemory:
        self.confirm_calls.append((scope, candidate_id, adoption_method))
        memory = ConfirmedMemory(
            memory_id=uuid4(),
            scope=scope,
            text=f"记忆{candidate_id}",
            category=MemoryCategory.PREFERENCE,
            source_ids=(CONTACT_ID,),
            source_candidate_id=candidate_id,
            adoption_method=adoption_method,
        )
        self.memories.append(memory)
        return memory

    def reject_candidate(self, *, scope: ContactScope, candidate_id: UUID) -> MemoryCandidate:
        self.reject_calls.append((scope, candidate_id))
    def discard_candidate_with_fingerprint(self, *, scope: ContactScope, candidate_id: UUID) -> MemoryCandidate:
        self.discard_calls.append((scope, candidate_id))
        return MemoryCandidate(
            candidate_id=candidate_id,
            scope=scope,
            text="已丢弃",
            category=MemoryCategory.PREFERENCE,
            source_ids=(CONTACT_ID,),
        )

        return MemoryCandidate(
            candidate_id=candidate_id,
            scope=scope,
            text="待丢弃",
            category=MemoryCategory.PREFERENCE,
            source_ids=(CONTACT_ID,),
        )

    def correct(
        self,
        *,
        scope: ContactScope,
        memory_id: UUID,
        text: str,
        category: MemoryCategory | None = None,
        change_kind: MemoryChangeKind = MemoryChangeKind.ERROR_CORRECTION,
    ) -> ConfirmedMemory:
        self.correct_calls.append((scope, memory_id, text, category))
        return ConfirmedMemory(
            memory_id=memory_id,
            scope=scope,
            text=text,
            category=category or MemoryCategory.PREFERENCE,
            source_ids=(CONTACT_ID,),
            source_candidate_id=None,
            adoption_method=AdoptionMethod.MANUAL,
        )

    def delete(self, *, scope: ContactScope, memory_id: UUID) -> ConfirmedMemory:
        self.delete_calls.append((scope, memory_id))
        memory = ConfirmedMemory(
            memory_id=memory_id,
            scope=scope,
            text="已删除",
            category=MemoryCategory.PREFERENCE,
            source_ids=(CONTACT_ID,),
            source_candidate_id=None,
            adoption_method=AdoptionMethod.AUTO,
            status=ConfirmedMemoryStatus.DELETED,
        )
        return memory


class FakeOwnerMemory:
    def __init__(self) -> None:
        self.memories: list[OwnerMemory] = []
        self.delete_calls: list[tuple[UUID, UUID]] = []

    def create(self, memory: OwnerMemory) -> OwnerMemory:
        self.memories.append(memory)
        return memory

    def confirm_candidate(
        self,
        *,
        candidate: MemoryCandidate,
        adoption_method: AdoptionMethod = AdoptionMethod.MANUAL,
    ) -> OwnerMemory:
        memory = OwnerMemory(
            memory_id=uuid4(),
            owner_id=candidate.scope.owner_id,
            text=candidate.text,
            category=candidate.category,
            topic=candidate.topic,
            source_ids=candidate.source_ids,
            source_candidate_id=candidate.candidate_id,
            adoption_method=adoption_method,
            status=ConfirmedMemoryStatus.ACTIVE,
            valid_at=candidate.valid_at,
            invalid_at=candidate.invalid_at,
            confidence=candidate.confidence,
            risk_flags=candidate.risk_flags,
        )
        self.memories.append(memory)
        return memory

    def list_active(self, owner_id: UUID, *, include_invalidated: bool = False, include_expired: bool = False) -> tuple[OwnerMemory, ...]:
        return tuple(
            memory
            for memory in self.memories
            if memory.owner_id == owner_id
            and (memory.status is ConfirmedMemoryStatus.ACTIVE
                 or (include_invalidated and memory.status is ConfirmedMemoryStatus.INVALIDATED))
        )

    def delete(self, owner_id: UUID, memory_id: UUID) -> OwnerMemory:
        self.delete_calls.append((owner_id, memory_id))
        memory = OwnerMemory(
            memory_id=memory_id,
            owner_id=owner_id,
            text="已删除",
            category=MemoryCategory.PREFERENCE,
            topic=MemoryTopic.OTHER,
            source_ids=(owner_id,),
            adoption_method=AdoptionMethod.AUTO,
            status=ConfirmedMemoryStatus.DELETED,
        )
        return memory


class MemoryServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.contact = FakeContactMemory()
        self.owner = FakeOwnerMemory()
        self.service = MemoryService(
            contact_memory=self.contact,
            owner_memory=self.owner,
        )

    def test_lists_contact_memories_within_scope(self) -> None:
        memory = ConfirmedMemory(
            memory_id=uuid4(),
            scope=_scope(),
            text="对方喜欢提前约时间。",
            category=MemoryCategory.PREFERENCE,
            source_ids=(CONTACT_ID,),
            source_candidate_id=None,
            adoption_method=AdoptionMethod.AUTO,
        )
        self.contact.memories.append(memory)

        result = self.service.list_contact_memories(
            owner_id=OWNER_ID,
            contact_id=CONTACT_ID,
        )

        self.assertEqual(result, (memory,))

    def test_management_list_includes_invalidated_and_expired_but_not_deleted(self) -> None:
        contact = InMemoryMemoryStore()
        candidate = MemoryCandidate(
            candidate_id=uuid4(), scope=_scope(), text="过去喜欢散步",
            category=MemoryCategory.PREFERENCE, source_ids=(CONTACT_ID,),
        )
        contact.create_candidate(candidate)
        old = contact.confirm(scope=_scope(), candidate_id=candidate.candidate_id)
        retired = contact.invalidate(scope=_scope(), memory_id=old.memory_id)
        service = MemoryService(contact_memory=contact, owner_memory=self.owner)
        self.assertEqual(contact.list_confirmed(_scope()), ())
        self.assertEqual(service.list_contact_memories(
            owner_id=OWNER_ID, contact_id=CONTACT_ID,
        ), (retired,))
        self.assertEqual(service.list_contact_memories(
            owner_id=OWNER_ID, contact_id=uuid4(),
        ), ())
        contact.delete(scope=_scope(), memory_id=old.memory_id)
        self.assertEqual(service.list_contact_memories(
            owner_id=OWNER_ID, contact_id=CONTACT_ID,
        ), ())
        expired_candidate = replace(
            candidate, candidate_id=uuid4(), text="过去的临时安排",
            invalid_at=datetime.now(timezone.utc) - timedelta(days=1),
        )
        contact.create_candidate(expired_candidate)
        expired = contact.confirm(scope=_scope(), candidate_id=expired_candidate.candidate_id)
        self.assertEqual(contact.list_confirmed(_scope()), ())
        self.assertEqual(service.list_contact_memories(
            owner_id=OWNER_ID, contact_id=CONTACT_ID,
        ), (expired,))

    def test_owner_management_list_includes_invalidated_but_not_deleted_or_other_owner(self) -> None:
        memory = OwnerMemory(
            memory_id=uuid4(), owner_id=OWNER_ID, text="本人以前喜欢散步",
            category=MemoryCategory.PREFERENCE, topic=MemoryTopic.OTHER,
            source_ids=(OWNER_ID,), adoption_method=AdoptionMethod.MANUAL,
            status=ConfirmedMemoryStatus.INVALIDATED,
        )
        self.owner.memories.extend((
            memory,
            replace(memory, memory_id=uuid4(), status=ConfirmedMemoryStatus.DELETED),
            replace(memory, memory_id=uuid4(), owner_id=uuid4()),
        ))
        self.assertEqual(self.owner.list_active(OWNER_ID), ())
        self.assertEqual(self.service.list_owner_memories(owner_id=OWNER_ID), (memory,))

    def test_confirms_pending_candidate_as_manual(self) -> None:
        candidate = MemoryCandidate(
            candidate_id=uuid4(),
            scope=_scope(),
            text="待确认联系人记忆",
            category=MemoryCategory.PREFERENCE,
            source_ids=(CONTACT_ID,),
        )
        self.contact.candidates.append(candidate)

        memory = self.service.confirm_candidate(
            owner_id=OWNER_ID,
            contact_id=CONTACT_ID,
            candidate_id=candidate.candidate_id,
        )

        self.assertEqual(memory.adoption_method, AdoptionMethod.MANUAL)
        scope, _, method = self.contact.confirm_calls[-1]
        self.assertEqual(scope, _scope())
        self.assertEqual(method, AdoptionMethod.MANUAL)

    def test_confirms_pending_self_fact_as_owner_memory(self) -> None:
        contact = InMemoryMemoryStore()
        owner = FakeOwnerMemory()
        adoption = MemoryAdoption(
            memory_port=contact,
            owner_memory_port=owner,
        )
        fact = ExtractedFact(
            text="我最近在减肥",
            category=MemoryCategory.RECENT_STATE,
            subject=FactSubject.SELF,
            topic=MemoryTopic.HEALTH,
            source_message_ids=(uuid4(),),
            confidence=0.3,
            valid_at=datetime(2026, 9, 1, tzinfo=timezone.utc),
            speech_act=SpeechAct.ASSERTION,
            assertion_status=AssertionStatus.ASSERTED,
            figurative_type=FigurativeType.LITERAL,
        )
        stats = adoption.adopt(
            _scope(),
            ExtractionOutcome(accepted=(fact,)),
        )
        candidate = contact.list_pending_candidates(_scope())[0]
        service = MemoryService(
            contact_memory=contact,
            owner_memory=owner,
        )

        confirmed = service.confirm_candidate(
            owner_id=OWNER_ID,
            contact_id=CONTACT_ID,
            candidate_id=candidate.candidate_id,
        )

        self.assertEqual(stats.pending, 1)
        self.assertIsInstance(confirmed, OwnerMemory)
        self.assertEqual(confirmed.text, fact.text)
        self.assertEqual(contact.list_confirmed(_scope()), ())
        self.assertEqual(owner.list_active(OWNER_ID), (confirmed,))

    def test_discards_pending_candidate(self) -> None:
        candidate_id = uuid4()

        self.service.discard_candidate(
            owner_id=OWNER_ID,
            contact_id=CONTACT_ID,
            candidate_id=candidate_id,
        )

        self.assertEqual(
            self.contact.discard_calls,
            [(_scope(), candidate_id)],
        )

    def test_manual_contact_entry_goes_through_candidate_confirmation(self) -> None:
        entry = ManualMemoryEntry(
            text="对方偏好早起。",
            category=MemoryCategory.PREFERENCE,
            topic=MemoryTopic.OTHER,
        )

        memory = self.service.add_manual_contact_memory(
            owner_id=OWNER_ID,
            contact_id=CONTACT_ID,
            entry=entry,
        )

        self.assertEqual(memory.adoption_method, AdoptionMethod.MANUAL)
        created = self.contact.candidates[-1]
        self.assertEqual(created.text, entry.text)
        self.assertEqual(created.scope, _scope())
        confirmed_id = self.contact.confirm_calls[-1][1]
        self.assertEqual(created.candidate_id, confirmed_id)

    def test_manual_owner_entry_is_manual_active(self) -> None:
        entry = ManualMemoryEntry(
            text="我倾向工作日晚上健身。",
            category=MemoryCategory.PREFERENCE,
        )

        memory = self.service.add_manual_owner_memory(
            owner_id=OWNER_ID,
            entry=entry,
        )

        self.assertEqual(memory.adoption_method, AdoptionMethod.MANUAL)
        self.assertEqual(memory.status, ConfirmedMemoryStatus.ACTIVE)
        self.assertEqual(memory.text, entry.text)

    def test_correct_memory_delegates(self) -> None:
        memory_id = uuid4()

        self.service.correct_memory(
            owner_id=OWNER_ID,
            contact_id=CONTACT_ID,
            memory_id=memory_id,
            text="修正后的记忆",
            category=MemoryCategory.COMMON_FACT,
        )

        self.assertEqual(
            self.contact.correct_calls,
            [(_scope(), memory_id, "修正后的记忆", MemoryCategory.COMMON_FACT)],
        )

    def test_delete_contact_memory_delegates(self) -> None:
        memory_id = uuid4()

        result = self.service.delete_contact_memory(
            owner_id=OWNER_ID,
            contact_id=CONTACT_ID,
            memory_id=memory_id,
        )

        self.assertEqual(self.contact.delete_calls, [(_scope(), memory_id)])
        self.assertEqual(result.status, ConfirmedMemoryStatus.DELETED)


if __name__ == "__main__":
    unittest.main()
