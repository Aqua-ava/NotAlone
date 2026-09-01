"""关系记忆采纳的公开行为测试。"""

from __future__ import annotations

import unittest
from datetime import datetime, timezone
from uuid import UUID

from notalone.memory import (
    AdoptionMethod,
    InMemoryMemoryStore,
    MemoryCategory,
    MemoryTopic,
)
from notalone.memory_extraction.adoption import MemoryAdoption
from notalone.memory_extraction.flow import ExtractionOutcome
from notalone.memory_extraction.models import ExtractedFact, FactSubject
from notalone.scopes import ContactScope


OWNER_ID = UUID("aaaaaaaa-1111-1111-1111-111111111111")
CONTACT_ID = UUID("bbbbbbbb-2222-2222-2222-222222222222")
SOURCE_ID = UUID("cccccccc-3333-3333-3333-333333333333")


class MemoryAdoptionTest(unittest.TestCase):
    """只通过 MemoryAdoption 和 MemoryPort 验证可观察生命周期。"""

    def setUp(self) -> None:
        self.scope = ContactScope(OWNER_ID, CONTACT_ID)
        self.store = InMemoryMemoryStore()
        self.adoption = MemoryAdoption(memory_port=self.store)

    def _fact(self, **overrides: object) -> ExtractedFact:
        values: dict[str, object] = {
            "text": "对方最近开始跑步",
            "category": MemoryCategory.RECENT_STATE,
            "subject": FactSubject.CONTACT,
            "topic": MemoryTopic.HEALTH,
            "source_message_ids": (SOURCE_ID,),
            "confidence": 0.92,
            "risk_flags": (),
            "valid_at": datetime(2026, 9, 1, tzinfo=timezone.utc),
            "invalid_at": datetime(2026, 10, 1, tzinfo=timezone.utc),
        }
        values.update(overrides)
        return ExtractedFact(**values)

    def test_sensitive_fact_keeps_provenance_in_pending_candidate(self) -> None:
        stats = self.adoption.adopt(
            self.scope,
            ExtractionOutcome(
                accepted=(self._fact(risk_flags=("health",)),)
            ),
        )

        self.assertEqual(stats.pending, 1)
        self.assertEqual(self.store.list_confirmed(self.scope), ())
        candidates = self.store.list_pending_candidates(self.scope)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].confidence, 0.92)
        self.assertEqual(candidates[0].risk_flags, ("health",))
        self.assertEqual(candidates[0].source_ids, (SOURCE_ID,))
        self.assertEqual(candidates[0].valid_at.year, 2026)

    def test_low_risk_fact_is_auto_adopted_with_provenance(self) -> None:
        stats = self.adoption.adopt(
            self.scope,
            ExtractionOutcome(accepted=(self._fact(),)),
        )

        self.assertEqual(stats.adopted, 1)
        memory = self.store.list_confirmed(self.scope)[0]
        self.assertEqual(memory.adoption_method, AdoptionMethod.AUTO)
        self.assertEqual(memory.confidence, 0.92)
        self.assertEqual(memory.risk_flags, ())
        self.assertEqual(memory.source_ids, (SOURCE_ID,))

    def test_repeating_same_pending_fact_is_idempotent(self) -> None:
        fact = self._fact(confidence=0.3)
        first = self.adoption.adopt(
            self.scope, ExtractionOutcome(accepted=(fact,))
        )
        second = self.adoption.adopt(
            self.scope, ExtractionOutcome(accepted=(fact,))
        )

        self.assertEqual(first.pending, 1)
        self.assertEqual(second.skipped_duplicate, 1)
        self.assertEqual(len(self.store.list_pending_candidates(self.scope)), 1)

    def test_correction_creates_a_new_active_version(self) -> None:
        self.adoption.adopt(
            self.scope,
            ExtractionOutcome(accepted=(self._fact(),)),
        )
        old = self.store.list_confirmed(self.scope)[0]

        corrected = self.store.correct(
            scope=self.scope,
            memory_id=old.memory_id,
            text="对方最近开始游泳",
        )

        self.assertNotEqual(corrected.memory_id, old.memory_id)
        self.assertEqual(
            self.store.list_confirmed(self.scope),
            (corrected,),
        )
        self.assertEqual(corrected.revision, old.revision + 1)


if __name__ == "__main__":
    unittest.main()
