"""联系人记忆目录的确定性 PostgreSQL 集成测试。"""

from __future__ import annotations

import os
import unittest
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import psycopg

from notalone.memory import (
    MemoryCandidate,
    MemoryCategory,
    MemoryTopic,
)
from notalone.persistence import (
    PostgresContactMemoryIndexRepository,
    PostgresMemoryStore,
)
from notalone.scopes import ContactScope


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class FailingIndexBuilder:
    def build(self, memories: object) -> object:  # noqa: ARG002
        raise RuntimeError("synthetic index build failure")


class ContactMemoryIndexTest(unittest.TestCase):
    """只使用合成联系人、来源和关系记忆。"""

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
            raise RuntimeError("集成测试只允许连接名称以 _test 结尾的数据库。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        self.scope = ContactScope(self.owner_id, self.contact_id)
        self.source_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "合成目录用户"),
            )
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) "
                "VALUES (%s, %s, %s)",
                (self.owner_id, self.contact_id, "合成目录联系人"),
            )
            connection.execute(
                """
                INSERT INTO public.source_document (
                    id, owner_id, contact_id, source_type, file_name,
                    content_sha256, record_count, status
                ) VALUES (%s, %s, %s, 'wechat_jsonl', 'index.jsonl', %s, 1, 'active')
                """,
                (
                    self.source_id,
                    self.owner_id,
                    self.contact_id,
                    "d" * 64,
                ),
            )
        self.memory_store = PostgresMemoryStore(TEST_DATABASE_URL)
        self.index_repository = PostgresContactMemoryIndexRepository(
            TEST_DATABASE_URL
        )

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )

    def _add_memory(
        self,
        *,
        number: int,
        category: MemoryCategory = MemoryCategory.PREFERENCE,
        topic: MemoryTopic = MemoryTopic.WORK,
        invalid_at: datetime | None = None,
    ) -> UUID:
        candidate = self.memory_store.create_candidate(
            MemoryCandidate(
                candidate_id=uuid4(),
                scope=self.scope,
                text=f"合成目录事实 {number}",
                category=category,
                topic=topic,
                source_ids=(self.source_id,),
                invalid_at=invalid_at,
            )
        )
        return self.memory_store.confirm(
            scope=self.scope,
            candidate_id=candidate.candidate_id,
        ).memory_id

    def test_rebuild_filters_expired_memories_and_caps_topics(self) -> None:
        now = datetime.now(timezone.utc)
        expired_id = self._add_memory(
            number=0,
            topic=MemoryTopic.EMOTION,
            invalid_at=now - timedelta(seconds=1),
        )
        for number, topic in enumerate(
            (
                MemoryTopic.HEALTH,
                MemoryTopic.WORK,
                MemoryTopic.FAMILY,
                MemoryTopic.TRAVEL,
                MemoryTopic.FINANCE,
                MemoryTopic.STUDY,
                MemoryTopic.EMOTION,
                MemoryTopic.OTHER,
            ),
            start=1,
        ):
            self._add_memory(number=number, topic=topic)
        topics = tuple(MemoryTopic)
        for number in range(9, 25):
            self._add_memory(
                number=number,
                category=(
                    MemoryCategory.COMMON_FACT
                    if number < 17
                    else MemoryCategory.RELATIONSHIP_NOTE
                ),
                topic=topics[(number - 9) % len(topics)],
            )

        built = self.index_repository.rebuild(self.scope)
        index = self.index_repository.get(self.scope)

        self.assertEqual(built.built_from_memory_revision, 25)
        self.assertIsNotNone(index)
        assert index is not None
        self.assertTrue(index.is_current)
        self.assertLessEqual(len(index.topics), 20)
        indexed_ids = {
            memory_id
            for topic in index.topics
            for memory_id in topic.memory_ids
        }
        self.assertNotIn(expired_id, indexed_ids)
        self.assertNotIn("合成目录事实", index.raw_topics_json)

    def test_incremental_update_delete_and_revision_staleness(self) -> None:
        first_id = self._add_memory(number=1)
        self.index_repository.rebuild(self.scope)
        second_id = self._add_memory(number=2, topic=MemoryTopic.TRAVEL)

        updated = self.index_repository.incremental_update(
            self.scope,
            changed_memory_ids=(second_id,),
        )
        self.assertEqual(updated.mode, "incremental")
        self.assertIn(second_id, updated.memory_ids)
        self.assertTrue(self.index_repository.get(self.scope).is_current)

        self.memory_store.delete(scope=self.scope, memory_id=first_id)
        deleted = self.index_repository.incremental_update(
            self.scope,
            changed_memory_ids=(first_id,),
        )
        self.assertNotIn(first_id, deleted.memory_ids)
        self.assertIn(second_id, deleted.memory_ids)

        third_id = self._add_memory(number=3, topic=MemoryTopic.FAMILY)
        stale = self.index_repository.get(self.scope)
        self.assertFalse(stale.is_current)
        self.assertIn(third_id, {
            memory_id
            for topic in self.index_repository.rebuild(self.scope).topics
            for memory_id in topic.memory_ids
        })

    def test_l2_navigation_returns_only_current_directory_references(self) -> None:
        memory_id = self._add_memory(number=1)
        self.index_repository.rebuild(self.scope)

        self.assertEqual(
            self.index_repository.locate_memory_ids(self.scope),
            (memory_id,),
        )

        self.memory_store.delete(scope=self.scope, memory_id=memory_id)
        # 目录 revision 已落后，旧 L2 不能继续导航到已删除 L1。
        self.assertIsNone(
            self.index_repository.locate_memory_ids(self.scope)
        )
        self.index_repository.rebuild(self.scope)
        self.assertEqual(
            self.index_repository.locate_memory_ids(self.scope),
            (),
        )

    def test_failed_rebuild_keeps_previous_index(self) -> None:
        memory_id = self._add_memory(number=1)
        self.index_repository.rebuild(self.scope)
        old_index = self.index_repository.get(self.scope)
        failing_repository = PostgresContactMemoryIndexRepository(
            TEST_DATABASE_URL,
            builder=FailingIndexBuilder(),
        )

        with self.assertRaises(RuntimeError):
            failing_repository.rebuild(self.scope)

        current = self.index_repository.get(self.scope)
        self.assertEqual(current.built_from_memory_revision, old_index.built_from_memory_revision)
        self.assertIn(
            memory_id,
            {
                item
                for topic in current.topics
                for item in topic.memory_ids
            },
        )

    def test_index_isolated_between_contacts(self) -> None:
        other_contact_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) "
                "VALUES (%s, %s, %s)",
                (self.owner_id, other_contact_id, "另一个合成联系人"),
            )
        self._add_memory(number=1)
        self.index_repository.rebuild(self.scope)

        self.assertIsNone(
            self.index_repository.get(
                ContactScope(self.owner_id, other_contact_id)
            )
        )

    def test_index_isolated_between_owners(self) -> None:
        other_owner_id = uuid4()
        other_contact_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (other_owner_id, "另一个合成目录用户"),
            )
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) "
                "VALUES (%s, %s, %s)",
                (other_owner_id, other_contact_id, "另一个目录联系人"),
            )
        try:
            self._add_memory(number=1)
            self.index_repository.rebuild(self.scope)
            self.assertIsNone(
                self.index_repository.get(
                    ContactScope(other_owner_id, other_contact_id)
                )
            )
        finally:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                connection.execute(
                    "DELETE FROM public.owner WHERE id = %s",
                    (other_owner_id,),
                )

    def test_source_expiry_invalidates_read_directory(self) -> None:
        self._add_memory(number=1)
        self.index_repository.rebuild(self.scope)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.source_document SET status = 'delete_failed' "
                "WHERE id = %s",
                (self.source_id,),
            )

        current = self.index_repository.get(self.scope)
        self.assertIsNotNone(current)
        assert current is not None
        self.assertFalse(current.is_current)


if __name__ == "__main__":
    unittest.main()
