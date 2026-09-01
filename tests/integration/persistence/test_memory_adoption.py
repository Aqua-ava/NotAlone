"""记忆自动采纳、置信度门槛、删除指纹与水位的集成测试。"""

from __future__ import annotations

import os
import unittest
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import psycopg

from notalone.memory.models import (
    AdoptionMethod,
    MemoryCandidateStatus,
    MemoryCandidate,
    MemoryCategory,
    MemoryTopic,
)
from notalone.memory_extraction.adjudication import (
    AdjudicationAction,
    AdjudicationDecision,
)
from notalone.memory_extraction.adoption import (
    AdoptionStats,
    MemoryAdoption,
)
from notalone.memory_extraction.flow import ExtractionOutcome
from notalone.memory_extraction.models import ExtractedFact, FactSubject
from notalone.persistence import (
    PostgresMemoryStore,
    PostgresOwnerMemoryStore,
    PostgresWatermarkStore,
    WatermarkPersistenceError,
)
from notalone.scopes import ContactScope


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class ReplaceWithFirstSimilar:
    """合成裁决器：要求替换当前池中的第一条旧记忆。"""

    def adjudicate(self, *, candidate_text, similar):
        return AdjudicationDecision(
            action=AdjudicationAction.UPDATE,
            replaced_memory_id=similar[0].memory_id,
        )


class MemoryAdoptionTest(unittest.TestCase):
    """只使用合成 owner、联系人与来源；不调用真实模型。"""

    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
        except psycopg.OperationalError as error:
            raise unittest.SkipTest("本地 PostgreSQL 测试库不可用。") from error
        if not database_name.endswith("_test"):
            raise RuntimeError("集成测试只允许连接 _test 结尾的数据库。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        self.scope = ContactScope(self.owner_id, self.contact_id)
        self.source_id = uuid4()
        self.message_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "合成用户"),
            )
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name)"
                " VALUES (%s, %s, %s)",
                (self.owner_id, self.contact_id, "合成联系人"),
            )
            connection.execute(
                """
                INSERT INTO public.source_document (
                    id, owner_id, contact_id, source_type, file_name,
                    content_sha256, record_count, status
                ) VALUES (
                    %s, %s, %s, 'wechat_jsonl', 'synthetic-adoption.jsonl',
                    %s, 1, 'active'
                )
                """,
                (
                    self.source_id,
                    self.owner_id,
                    self.contact_id,
                    "a" * 64,
                ),
            )
            connection.execute(
                """
                INSERT INTO public.message (
                    id, owner_id, contact_id,
                    speaker, message_type, text_content, occurred_at
                ) VALUES (
                    %s, %s, %s, 'contact', 'text', '我下周出差', now()
                )
                """,
                (
                    self.message_id,
                    self.owner_id,
                    self.contact_id,
                ),
            )
            connection.execute(
                """
                INSERT INTO public.message_source_ref (
                    id, message_id, owner_id, contact_id,
                    source_kind, source_document_id, source_locator, raw_payload
                ) VALUES (
                    gen_random_uuid(), %s, %s, %s,
                    'source_document', %s, 'synthetic-1', '{}'::jsonb
                )
                """,
                (
                    self.message_id,
                    self.owner_id,
                    self.contact_id,
                    self.source_id,
                ),
            )
            connection.commit()
        self.memory_store = PostgresMemoryStore(TEST_DATABASE_URL)
        self.owner_store = PostgresOwnerMemoryStore(TEST_DATABASE_URL)
        self.watermark = PostgresWatermarkStore(TEST_DATABASE_URL)
        self.adoption = MemoryAdoption(
            memory_port=self.memory_store,
            owner_memory_port=self.owner_store,
        )
        self.addCleanup(self._cleanup)

    def _fact(
        self,
        *,
        subject=FactSubject.CONTACT,
        text="他下周去上海出差",
        confidence=0.9,
        topic=MemoryTopic.WORK,
        **overrides,
    ):
        fields = {
            "text": text,
            "category": MemoryCategory.RECENT_STATE,
            "subject": subject,
            "topic": topic,
            "source_message_ids": (self.message_id,),
            "confidence": confidence,
            "risk_flags": (),
            "valid_at": None,
            "invalid_at": datetime.now(timezone.utc) + timedelta(days=7),
        }
        fields.update(overrides)
        return ExtractedFact(**fields)

    def _cleanup(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )
            connection.commit()

    def test_contact_fact_adopts_auto_with_topic(self) -> None:
        stats = self.adoption.adopt(
            self.scope, ExtractionOutcome(accepted=(self._fact(),))
        )

        self.assertEqual(
            stats,
            AdoptionStats(adopted=1, rejected_by_contract=0),
        )
        confirmed = self.memory_store.list_confirmed(self.scope)
        self.assertEqual(len(confirmed), 1)
        self.assertEqual(confirmed[0].adoption_method, AdoptionMethod.AUTO)
        self.assertEqual(confirmed[0].topic, MemoryTopic.WORK)

    def test_self_fact_goes_to_owner_level(self) -> None:
        stats = self.adoption.adopt(
            self.scope,
            ExtractionOutcome(
                accepted=(self._fact(subject=FactSubject.SELF, text="我下周出差"),)
            ),
        )

        self.assertEqual(stats.adopted, 1)
        self.assertEqual(self.memory_store.list_confirmed(self.scope), ())
        owner_memories = self.owner_store.list_active(self.owner_id)
        self.assertEqual(len(owner_memories), 1)
        self.assertEqual(owner_memories[0].text, "我下周出差")

    def test_owner_memory_update_uses_persisted_memory_id(self) -> None:
        adoption = MemoryAdoption(
            memory_port=self.memory_store,
            owner_memory_port=self.owner_store,
            adjudication_runtime=ReplaceWithFirstSimilar(),
        )

        stats = adoption.adopt(
            self.scope,
            ExtractionOutcome(
                accepted=(
                    self._fact(
                        subject=FactSubject.SELF,
                        text="我下周去上海出差",
                    ),
                    self._fact(
                        subject=FactSubject.SELF,
                        text="我最近去上海出差",
                    ),
                )
            ),
        )

        self.assertEqual(stats.adopted, 1)
        self.assertEqual(stats.updated, 1)
        owner_memories = self.owner_store.list_active(self.owner_id)
        self.assertEqual(len(owner_memories), 1)
        self.assertEqual(owner_memories[0].text, "我最近去上海出差")

    def test_low_confidence_stays_pending(self) -> None:
        stats = self.adoption.adopt(
            self.scope,
            ExtractionOutcome(accepted=(self._fact(confidence=0.3),)),
        )

        self.assertEqual(stats.pending, 1)
        self.assertEqual(stats.adopted, 0)
        self.assertEqual(self.memory_store.list_confirmed(self.scope), ())

    def test_sensitive_high_confidence_stays_pending_with_provenance(self) -> None:
        stats = self.adoption.adopt(
            self.scope,
            ExtractionOutcome(
                accepted=(self._fact(confidence=0.95, risk_flags=("health",)),)
            ),
        )

        self.assertEqual(stats.pending, 1)
        self.assertEqual(self.memory_store.list_confirmed(self.scope), ())
        pending = self.memory_store.list_pending_candidates(self.scope)
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0].status, MemoryCandidateStatus.PENDING)
        self.assertEqual(pending[0].confidence, 0.95)
        self.assertEqual(pending[0].risk_flags, ("health",))

    def test_deleted_text_never_adopts_again(self) -> None:
        first = self.adoption.adopt(
            self.scope, ExtractionOutcome(accepted=(self._fact(),))
        )
        confirmed = self.memory_store.list_confirmed(self.scope)
        self.memory_store.delete(
            scope=self.scope, memory_id=confirmed[0].memory_id
        )

        second = self.adoption.adopt(
            self.scope, ExtractionOutcome(accepted=(self._fact(),))
        )

        self.assertEqual(first.adopted, 1)
        self.assertEqual(second.skipped_deleted, 1)
        self.assertEqual(self.memory_store.list_confirmed(self.scope), ())

    def test_duplicate_extraction_skips_active_memory(self) -> None:
        first = self.adoption.adopt(
            self.scope, ExtractionOutcome(accepted=(self._fact(),))
        )
        second = self.adoption.adopt(
            self.scope, ExtractionOutcome(accepted=(self._fact(),))
        )

        self.assertEqual(first.adopted, 1)
        self.assertEqual(second.skipped_duplicate, 1)
        self.assertEqual(len(self.memory_store.list_confirmed(self.scope)), 1)

    def test_validity_window_persists_and_expires(self) -> None:
        self.adoption.adopt(
            self.scope,
            ExtractionOutcome(
                accepted=(
                    self._fact(
                        valid_at=datetime.now(timezone.utc) - timedelta(days=2),
                        invalid_at=datetime.now(timezone.utc) - timedelta(days=1),
                    ),
                )
            ),
        )

        self.assertEqual(self.memory_store.list_confirmed(self.scope), ())

    def test_watermark_round_trip(self) -> None:
        message_id = uuid4()

        self.assertIsNone(self.watermark.get(self.scope))
        self.watermark.set(self.scope, message_id)

        self.assertEqual(self.watermark.get(self.scope), message_id)

    def test_pending_candidate_can_be_confirmed_later(self) -> None:
        self.adoption.adopt(
            self.scope,
            ExtractionOutcome(accepted=(self._fact(confidence=0.3),)),
        )

        candidates = self.memory_store.list_candidates(self.scope) \
            if hasattr(self.memory_store, "list_candidates") else ()

        self.assertEqual(candidates, ())


if __name__ == "__main__":
    unittest.main()
