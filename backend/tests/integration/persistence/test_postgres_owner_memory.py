"""PostgreSQL owner 级自我记忆存储与检索拼接集成测试。"""

from __future__ import annotations

import os
import unittest
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import psycopg

from notalone.memory.models import (
    AdoptionMethod,
    ConfirmedMemoryStatus,
    MemoryCategory,
    MemoryTopic,
    OwnerMemory,
)
from notalone.persistence import (
    OwnerMemoryPersistenceError,
    PostgresOwnerMemoryStore,
    PostgresRetrieval,
)
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.scopes import ContactScope


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


def _synthetic_source(owner_id) -> UUID:
    """为指定 owner 建一条合成来源，返回其标识。

    owner 级记忆必须携带真实存在的来源引用；auto 采纳路径的来源
    校验由专用用例覆盖，这里为其余用例提供最小真实来源。
    """

    contact_id = uuid4()
    source_id = uuid4()
    with psycopg.connect(TEST_DATABASE_URL) as connection:
        connection.execute(
            """
            INSERT INTO public.contact (owner_id, id, display_name)
            VALUES (%s, %s, %s)
            """,
            (owner_id, contact_id, "来源合成联系人"),
        )
        connection.execute(
            """
            INSERT INTO public.source_document (
                id, owner_id, contact_id, source_type, file_name,
                content_sha256, record_count, status
            ) VALUES (
                %s, %s, %s, 'wechat_jsonl', 'synthetic-owner-source.jsonl',
                %s, 1, 'active'
            )
            """,
            (
                source_id,
                owner_id,
                contact_id,
                uuid4().hex * 2,
            ),
        )
        connection.commit()
    return source_id


def _owner_memory(owner_id, **overrides):
    fields = {
        "memory_id": uuid4(),
        "owner_id": owner_id,
        "text": "我下周去上海出差",
        "category": MemoryCategory.RECENT_STATE,
        "topic": MemoryTopic.WORK,
        "source_ids": (_synthetic_source(owner_id),),
        "adoption_method": AdoptionMethod.AUTO,
        "status": ConfirmedMemoryStatus.ACTIVE,
        "valid_at": datetime.now(timezone.utc),
        "invalid_at": datetime.now(timezone.utc) + timedelta(days=7),
        "revision": 1,
    }
    fields.update(overrides)
    return OwnerMemory(**fields)


class PostgresOwnerMemoryStoreTest(unittest.TestCase):
    """只使用合成 owner 与来源；owner 级记忆不携带联系人归属。"""

    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
                has_table = connection.execute(
                    "SELECT to_regclass('public.owner_memory')"
                ).fetchone()[0]
        except psycopg.OperationalError as error:
            raise unittest.SkipTest("本地 PostgreSQL 测试库不可用。") from error

        if not database_name.endswith("_test"):
            raise RuntimeError(
                "集成测试只允许连接名称以 _test 结尾的数据库。"
            )
        if has_table is None:
            raise unittest.SkipTest("测试库尚未应用 011 owner 记忆迁移。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "合成用户"),
            )
            connection.commit()
        self.store = PostgresOwnerMemoryStore(TEST_DATABASE_URL)
        self.retrieval = PostgresRetrieval(
            TEST_DATABASE_URL,
            memory_store=PostgresMemoryStore(TEST_DATABASE_URL),
            owner_memory_store=self.store,
        )
        self.addCleanup(self._cleanup)

    def _cleanup(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )
            connection.commit()

    def test_create_and_list_active(self) -> None:
        memory = _owner_memory(self.owner_id)

        saved = self.store.create(memory)
        listed = self.store.list_active(self.owner_id)

        self.assertEqual(listed, (saved,))
        self.assertEqual(saved.text, memory.text)
        self.assertIsNotNone(saved.timing.recorded_at)

    def test_create_with_active_source_succeeds(self) -> None:
        memory = _owner_memory(self.owner_id)

        saved = self.store.create(memory)

        self.assertEqual(self.store.list_active(self.owner_id), (saved,))

    def test_create_rejects_sources_removed_by_deletion(self) -> None:
        source_id = _synthetic_source(self.owner_id)
        memory = _owner_memory(
            self.owner_id,
            source_ids=(source_id, uuid4()),
        )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                """
                UPDATE public.source_document
                SET status = 'deleted', file_name = NULL,
                    content_sha256 = NULL, record_count = 0, deleted_at = now()
                WHERE id = %s
                """,
                (source_id,),
            )
            connection.commit()

        with self.assertRaises(PermissionError):
            self.store.create(memory)
        # 校验失败不得留下部分写入。
        self.assertEqual(self.store.list_active(self.owner_id), ())

    def test_owner_isolation(self) -> None:
        other_owner = self._create_other_owner()
        own = _owner_memory(self.owner_id)
        other = _owner_memory(other_owner)

        saved = self.store.create(own)
        self.store.create(other)

        self.assertEqual(self.store.list_active(self.owner_id), (saved,))

    def test_delete_keeps_only_tombstone_and_erases_private_body(self) -> None:
        memory = _owner_memory(self.owner_id)
        self.store.create(memory)

        deleted = self.store.delete(self.owner_id, memory.memory_id)

        self.assertEqual(self.store.list_active(self.owner_id), ())
        self.assertEqual(deleted.text, "已删除的资料")
        self.assertEqual(self.store.deleted_texts(self.owner_id), ("已删除的资料",))
        self.assertEqual(self.store.delete(self.owner_id, memory.memory_id), deleted)

    def test_retrieval_returns_owner_memories_with_validity(self) -> None:
        memory = _owner_memory(self.owner_id)
        self.store.create(memory)

        results = self.retrieval.search_owner_memories(owner_id=self.owner_id)

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].text, "我下周去上海出差")
        self.assertEqual(results[0].topic, MemoryTopic.WORK.value)

    def test_retrieval_excludes_expired_owner_memories(self) -> None:
        expired = _owner_memory(
            self.owner_id,
            valid_at=datetime.now(timezone.utc) - timedelta(days=2),
            invalid_at=datetime.now(timezone.utc) - timedelta(days=1),
        )
        self.store.create(expired)

        self.assertEqual(
            self.retrieval.search_owner_memories(owner_id=self.owner_id), ()
        )

    def test_retrieval_owner_isolation(self) -> None:
        other_owner = self._create_other_owner()
        self.store.create(_owner_memory(other_owner))

        self.assertEqual(
            self.retrieval.search_owner_memories(owner_id=self.owner_id), ()
        )

    def test_retrieval_scores_owner_memories_with_query(self) -> None:
        work = _owner_memory(self.owner_id, text="我最近在忙项目")
        hiking = _owner_memory(self.owner_id, text="我喜欢周末徒步")
        self.store.create(work)
        self.store.create(hiking)

        results = self.retrieval.search_owner_memories(
            owner_id=self.owner_id,
            query="周末一起去徒步吗？",
        )

        self.assertEqual(len(results), 2)
        self.assertEqual(results[0].memory_id, hiking.memory_id)
        self.assertGreater(results[0].relevance_score or 0.0, 0.0)
        self.assertIn("徒步", results[0].matched_terms)
        self.assertEqual(results[1].relevance_score, 0.0)

    def test_retrieval_revalidation_without_query_has_no_score(self) -> None:
        memory = _owner_memory(self.owner_id)
        self.store.create(memory)

        results = self.retrieval.search_owner_memories(
            owner_id=self.owner_id,
            query=None,
            memory_ids=(memory.memory_id,),
        )

        self.assertEqual(len(results), 1)
        self.assertIsNone(results[0].relevance_score)
        self.assertEqual(results[0].matched_terms, ())

    def _create_other_owner(self):
        other_owner = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (other_owner, "另一位合成用户"),
            )
            connection.commit()
        self.addCleanup(self._delete_owner_row(other_owner))
        return other_owner

    @staticmethod
    def _delete_owner_row(owner_id) -> None:
        def _delete() -> None:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                connection.execute(
                    "DELETE FROM public.owner WHERE id = %s",
                    (owner_id,),
                )
                connection.commit()

        return _delete

    def test_invalid_owner_id_raises(self) -> None:
        with self.assertRaises(OwnerMemoryPersistenceError):
            self.store.list_active("not-a-uuid")

    @staticmethod
    def _delete_rows_of(owner_id) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner_memory WHERE owner_id = %s",
                (owner_id,),
            )
            connection.commit()


if __name__ == "__main__":
    unittest.main()
