"""写入裁决四动作与版本化失效的集成测试。"""

from __future__ import annotations

import os
import unittest
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import psycopg

from notalone.memory_extraction.adjudication import (
    AdjudicationAction,
    AdjudicationDecision,
)
from notalone.memory_extraction.adoption import MemoryAdoption
from notalone.memory_extraction.errors import ExtractionRuntimeError
from notalone.memory_extraction.flow import ExtractionOutcome
from notalone.persistence import (
    PostgresMemoryStore,
    PostgresOwnerMemoryStore,
)
from notalone.scopes import ContactScope


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class ScriptedAdjudicator:
    """按脚本返回裁决动作的确定性运行时。"""

    def __init__(self, decisions) -> None:
        self.decisions = list(decisions)
        self.seen_candidates = []

    def adjudicate(self, *, candidate_text, similar):
        self.seen_candidates.append(candidate_text)
        return self.decisions.pop(0)


class CrashingAdjudicator:
    def adjudicate(self, *, candidate_text, similar):  # noqa: ARG002
        raise ExtractionRuntimeError("裁决模型未返回结构化结果。")


class WriteAdjudicationTest(unittest.TestCase):
    """只使用合成 owner、联系人与来源；裁决用脚本化 fake。"""

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
                ) VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic-adj.jsonl',
                          %s, 1, 'active')
                """,
                (self.source_id, self.owner_id, self.contact_id, "b" * 64),
            )
            connection.execute(
                """
                INSERT INTO public.message (
                    id, owner_id, contact_id,
                    speaker, message_type, text_content, occurred_at
                ) VALUES (%s, %s, %s, 'contact', 'text', '在减肥', now())
                """,
                (self.message_id, self.owner_id, self.contact_id),
            )
            connection.execute(
                """
                INSERT INTO public.message_source_ref (
                    id, message_id, owner_id, contact_id,
                    source_kind, source_document_id, source_locator, raw_payload
                ) VALUES (gen_random_uuid(), %s, %s, %s,
                          'source_document', %s, 'synthetic-1', '{}'::jsonb)
                """,
                (self.message_id, self.owner_id, self.contact_id, self.source_id),
            )
            connection.commit()
        self.memory_store = PostgresMemoryStore(TEST_DATABASE_URL)
        self.owner_store = PostgresOwnerMemoryStore(TEST_DATABASE_URL)
        self.addCleanup(self._cleanup)

    def _cleanup(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )
            connection.commit()

    def _adoption(self, adjudicator) -> MemoryAdoption:
        return MemoryAdoption(
            memory_port=self.memory_store,
            owner_memory_port=self.owner_store,
            adjudication_runtime=adjudicator,
        )

    def _fact(self, text, **overrides):
        from notalone.memory.models import MemoryCategory, MemoryTopic
        from notalone.memory_extraction.models import ExtractedFact, FactSubject

        fields = {
            "text": text,
            "category": MemoryCategory.RECENT_STATE,
            "subject": FactSubject.CONTACT,
            "topic": MemoryTopic.HEALTH,
            "source_message_ids": (self.message_id,),
            "confidence": 0.9,
            "risk_flags": (),
            "valid_at": None,
            "invalid_at": datetime.now(timezone.utc) + timedelta(days=7),
        }
        fields.update(overrides)
        return ExtractedFact(**fields)

    def _seed_memory(self, text="老王最近在减肥") -> object:
        self._adoption(None).adopt(
            self.scope, ExtractionOutcome(accepted=(self._fact(text),))
        )
        confirmed = self.memory_store.list_confirmed(self.scope)
        self.assertEqual(len(confirmed), 1)
        return confirmed[0]

    def test_update_replaces_old_version(self) -> None:
        old = self._seed_memory("老王最近在减肥")
        adjudicator = ScriptedAdjudicator(
            [
                AdjudicationDecision(
                    action=AdjudicationAction.UPDATE,
                    replaced_memory_id=old.memory_id,
                )
            ]
        )

        stats = self._adoption(adjudicator).adopt(
            self.scope,
            ExtractionOutcome(accepted=(self._fact("老王最近开始增肌了"),)),
        )

        self.assertEqual(stats.updated, 1)
        current = self.memory_store.list_confirmed(self.scope)
        self.assertEqual(len(current), 1)
        self.assertEqual(current[0].text, "老王最近开始增肌了")

    def test_noop_skips_duplicate_semantics(self) -> None:
        old = self._seed_memory("老王最近在减肥")
        adjudicator = ScriptedAdjudicator(
            [
                AdjudicationDecision(
                    action=AdjudicationAction.NOOP,
                    replaced_memory_id=None,
                )
            ]
        )

        stats = self._adoption(adjudicator).adopt(
            self.scope,
            ExtractionOutcome(accepted=(self._fact("老王最近在减肥中"),)),
        )

        self.assertEqual(stats.skipped_duplicate, 1)
        self.assertEqual(stats.adopted + stats.updated, 0)
        current = self.memory_store.list_confirmed(self.scope)
        self.assertEqual(current[0].memory_id, old.memory_id)

    def test_keep_stores_both(self) -> None:
        self._seed_memory("老王最近在减肥")
        adjudicator = ScriptedAdjudicator(
            [AdjudicationDecision(action=AdjudicationAction.KEEP)]
        )

        stats = self._adoption(adjudicator).adopt(
            self.scope,
            ExtractionOutcome(accepted=(self._fact("老王最近在健身增肌"),)),
        )

        self.assertEqual(stats.adopted, 1)
        self.assertEqual(len(self.memory_store.list_confirmed(self.scope)), 2)

    def test_update_with_foreign_memory_id_falls_back_to_add(self) -> None:
        self._seed_memory("老王最近在减肥")
        adjudicator = ScriptedAdjudicator(
            [
                AdjudicationDecision(
                    action=AdjudicationAction.UPDATE,
                    replaced_memory_id=uuid4(),
                )
            ]
        )

        stats = self._adoption(adjudicator).adopt(
            self.scope,
            ExtractionOutcome(accepted=(self._fact("老王最近开始增肌了"),)),
        )

        self.assertEqual(stats.adopted, 1)
        self.assertEqual(stats.updated, 0)
        self.assertEqual(len(self.memory_store.list_confirmed(self.scope)), 2)

    def test_adjudication_failure_propagates(self) -> None:
        self._seed_memory("老王最近在减肥")

        with self.assertRaises(ExtractionRuntimeError):
            self._adoption(CrashingAdjudicator()).adopt(
                self.scope,
                ExtractionOutcome(
                    accepted=(self._fact("老王最近开始增肌了"),)
                ),
            )

    def test_dissimilar_fact_skips_adjudication_call(self) -> None:
        self._seed_memory("老王最近在减肥")
        adjudicator = ScriptedAdjudicator([])

        stats = self._adoption(adjudicator).adopt(
            self.scope,
            ExtractionOutcome(
                accepted=(
                    self._fact("他女儿今年参加高考", confidence=0.95),
                )
            ),
        )

        self.assertEqual(stats.adopted, 1)
        self.assertEqual(adjudicator.seen_candidates, [])

    def test_owner_level_update_invalidates_old(self) -> None:
        from notalone.memory.models import MemoryCategory, MemoryTopic
        from notalone.memory_extraction.models import FactSubject

        self._adoption(None).adopt(
            self.scope,
            ExtractionOutcome(
                accepted=(
                    self._fact(
                        "我最近在减肥",
                        subject=FactSubject.SELF,
                        topic=MemoryTopic.HEALTH,
                    ),
                )
            ),
        )
        owner_memories = self.owner_store.list_active(self.owner_id)
        self.assertEqual(len(owner_memories), 1)
        adjudicator = ScriptedAdjudicator(
            [
                AdjudicationDecision(
                    action=AdjudicationAction.UPDATE,
                    replaced_memory_id=owner_memories[0].memory_id,
                )
            ]
        )

        stats = self._adoption(adjudicator).adopt(
            self.scope,
            ExtractionOutcome(
                accepted=(
                    self._fact(
                        "我最近开始增肌了",
                        subject=FactSubject.SELF,
                        topic=MemoryTopic.HEALTH,
                    ),
                )
            ),
        )

        self.assertEqual(stats.updated, 1)
        current = self.owner_store.list_active(self.owner_id)
        self.assertEqual(len(current), 1)
        self.assertEqual(current[0].text, "我最近开始增肌了")


if __name__ == "__main__":
    unittest.main()
