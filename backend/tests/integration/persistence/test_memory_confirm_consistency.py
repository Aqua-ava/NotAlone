"""确认/重放事务两侧一致性与来源校验去重的回归测试。

在隔离 PostgreSQL 测试库上用合成来源断言：contact 与 owner 两个
store 对 expected_dimension_evidence 的校验时点一致（重放也校验，
fail-closed），且确认路径不再重复查询同一来源集合。
"""

from __future__ import annotations

import unittest
from uuid import uuid4

from psycopg.rows import dict_row

from notalone.memory import AdoptionMethod, FactSubject
from notalone.memory.dimension_evidence import (
    DimensionEvidence,
    DimensionEvidenceChangedError,
    EvidenceMessage,
)
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from tests.integration.persistence.query_counting import CountingConnection, QueryCounter
from tests.integration.persistence.test_memory_timing import PostgresMemoryTimingTest


def _synthetic_evidence(scope, *, candidate_sha256: str = "a" * 64) -> DimensionEvidence:
    """只用于比较的结构合法依据对象；不声称任何来源核验通过。"""
    return DimensionEvidence(
        scope=scope,
        candidate_sha256=candidate_sha256,
        window_sha256="b" * 64,
        messages=(
            EvidenceMessage(
                message_id=uuid4(),
                text_sha256="c" * 64,
                text_length=1,
                sender="contact",
                message_type="text",
                occurred_at=None,
                source_refs=(),
                text_representation="text",
                source_state_sha256=None,
            ),
        ),
        version=1,
    )


class MemoryConfirmConsistencyTest(PostgresMemoryTimingTest):
    def _counted_store(self) -> tuple[PostgresMemoryStore, QueryCounter]:
        counter = QueryCounter()
        store = PostgresMemoryStore(
            self.database_url,
            connection_factory=lambda: CountingConnection.connect(
                self.database_url, row_factory=dict_row, counter=counter,
            ),
        )
        return store, counter

    def _confirmed_contact(self):
        candidate = self.store.create_candidate(self._candidate((self.first,)))
        memory = self.store.confirm(
            scope=self.scope, candidate_id=candidate.candidate_id,
            adoption_method=AdoptionMethod.MANUAL,
        )
        return candidate, memory

    def _confirmed_owner(self):
        candidate = self.store.create_candidate(
            self._candidate((self.first,), subject=FactSubject.SELF),
        )
        owner_store = PostgresOwnerMemoryStore(self.database_url)
        memory = owner_store.confirm_candidate(
            candidate=candidate, adoption_method=AdoptionMethod.MANUAL,
        )
        return candidate, memory

    def test_contact_replay_rejects_changed_expected_evidence(self) -> None:
        candidate, memory = self._confirmed_contact()
        expected = _synthetic_evidence(self.scope)

        with self.assertRaises(DimensionEvidenceChangedError):
            self.store.confirm(
                scope=self.scope, candidate_id=candidate.candidate_id,
                adoption_method=AdoptionMethod.MANUAL,
                expected_dimension_evidence=expected,
            )

        self.assertEqual(
            self.store.get_candidate(
                scope=self.scope, candidate_id=candidate.candidate_id,
            ).status.value,
            "confirmed",
        )
        current = self.store.list_confirmed(self.scope)
        self.assertEqual([item.memory_id for item in current], [memory.memory_id])
        replayed = self.store.confirm(
            scope=self.scope, candidate_id=candidate.candidate_id,
            adoption_method=AdoptionMethod.MANUAL,
        )
        self.assertEqual(replayed.memory_id, memory.memory_id)

    def test_owner_replay_rejects_changed_expected_evidence(self) -> None:
        candidate, memory = self._confirmed_owner()
        owner_store = PostgresOwnerMemoryStore(self.database_url)
        expected = _synthetic_evidence(self.scope)

        with self.assertRaises(DimensionEvidenceChangedError):
            owner_store.confirm_candidate(
                candidate=candidate, adoption_method=AdoptionMethod.MANUAL,
                expected_dimension_evidence=expected,
            )

        self.assertEqual(
            self.store.get_candidate(
                scope=self.scope, candidate_id=candidate.candidate_id,
            ).status.value,
            "confirmed",
        )
        current = owner_store.list_active(self.scope.owner_id)
        self.assertEqual([item.memory_id for item in current], [memory.memory_id])
        replayed = owner_store.confirm_candidate(
            candidate=candidate, adoption_method=AdoptionMethod.MANUAL,
        )
        self.assertEqual(replayed.memory_id, memory.memory_id)

    def test_contact_fresh_confirm_rejects_mismatched_expected_evidence(self) -> None:
        candidate = self.store.create_candidate(self._candidate((self.first,)))

        with self.assertRaises(DimensionEvidenceChangedError):
            self.store.confirm(
                scope=self.scope, candidate_id=candidate.candidate_id,
                adoption_method=AdoptionMethod.MANUAL,
                expected_dimension_evidence=_synthetic_evidence(self.scope),
            )

        self.assertEqual(self.store.list_confirmed(self.scope), ())
        self.assertEqual(
            self.store.get_candidate(
                scope=self.scope, candidate_id=candidate.candidate_id,
            ).status.value,
            "pending",
        )

    def test_owner_fresh_confirm_rejects_mismatched_expected_evidence(self) -> None:
        candidate = self.store.create_candidate(
            self._candidate((self.first,), subject=FactSubject.SELF),
        )
        owner_store = PostgresOwnerMemoryStore(self.database_url)

        with self.assertRaises(DimensionEvidenceChangedError):
            owner_store.confirm_candidate(
                candidate=candidate, adoption_method=AdoptionMethod.MANUAL,
                expected_dimension_evidence=_synthetic_evidence(self.scope),
            )

        self.assertEqual(owner_store.list_active(self.scope.owner_id), ())
        self.assertEqual(
            self.store.get_candidate(
                scope=self.scope, candidate_id=candidate.candidate_id,
            ).status.value,
            "pending",
        )

    def test_contact_confirm_checks_sources_once(self) -> None:
        candidate = self.store.create_candidate(self._candidate((self.first,)))
        store, counter = self._counted_store()
        store.confirm(scope=self.scope, candidate_id=candidate.candidate_id)
        self.assertEqual(len(counter.matching("AS available_sources")), 1)

    def test_contact_manual_update_confirm_checks_sources_once(self) -> None:
        parent_candidate = self.store.create_candidate(self._candidate((self.first,)))
        parent = self.store.confirm(
            scope=self.scope, candidate_id=parent_candidate.candidate_id,
            adoption_method=AdoptionMethod.MANUAL,
        )
        candidate = self.store.create_candidate(self._candidate((self.second,)))
        store, counter = self._counted_store()
        store.confirm(
            scope=self.scope, candidate_id=candidate.candidate_id,
            adoption_method=AdoptionMethod.MANUAL, expected_previous=parent,
        )
        self.assertEqual(len(counter.matching("AS available_sources")), 1)


if __name__ == "__main__":
    unittest.main()
