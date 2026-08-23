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


def _owner_memory(owner_id, **overrides):
    fields = {
        "memory_id": uuid4(),
        "owner_id": owner_id,
        "text": "我下周去上海出差",
        "category": MemoryCategory.RECENT_STATE,
        "topic": MemoryTopic.WORK,
        "source_ids": (uuid4(),),
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

        self.store.create(memory)
        listed = self.store.list_active(self.owner_id)

        self.assertEqual(listed, (memory,))

    def test_owner_isolation(self) -> None:
        other_owner = self._create_other_owner()
        own = _owner_memory(self.owner_id)
        other = _owner_memory(other_owner)

        self.store.create(own)
        self.store.create(other)

        self.assertEqual(self.store.list_active(self.owner_id), (own,))

    def test_delete_is_soft_and_keeps_fingerprint(self) -> None:
        memory = _owner_memory(self.owner_id)
        self.store.create(memory)

        self.store.delete(self.owner_id, memory.memory_id)

        self.assertEqual(self.store.list_active(self.owner_id), ())
        self.assertIn(
            "我下周去上海出差",
            self.store.deleted_texts(self.owner_id),
        )

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
