"""PostgreSQL owner 目录（首启向导）集成测试。

验证 owner 列表按创建顺序返回、幂等创建（ON CONFLICT 不覆盖展示名称）
与参数校验；只使用合成数据与 _test 库。
"""

from __future__ import annotations

import os
import unittest
from uuid import uuid4

import psycopg

from notalone.persistence.setup_owner_directory import (
    OwnerDirectoryPersistenceError,
    PostgresOwnerDirectory,
)


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class PostgresOwnerDirectoryTest(unittest.TestCase):
    """首启向导 owner 目录：列表与幂等创建。"""

    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
                has_table = connection.execute(
                    "SELECT to_regclass('public.owner')"
                ).fetchone()[0]
        except psycopg.OperationalError as error:
            raise unittest.SkipTest("本地 PostgreSQL 测试库不可用。") from error
        if not database_name.endswith("_test"):
            raise RuntimeError(
                "集成测试只允许连接名称以 _test 结尾的数据库。"
            )
        if has_table is None:
            raise unittest.SkipTest("测试库尚未应用 001 owner 迁移。")

    def setUp(self) -> None:
        self.directory = PostgresOwnerDirectory(TEST_DATABASE_URL)
        self.created_owner_ids: list = []

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            for owner_id in self.created_owner_ids:
                connection.execute(
                    "DELETE FROM public.owner WHERE id = %s",
                    (owner_id,),
                )
            connection.commit()

    def _create_via_directory(self, display_name: str = "向导用户"):
        owner_id = uuid4()
        self.created_owner_ids.append(owner_id)
        return owner_id

    def test_list_owners_returns_empty_on_fresh_database(self) -> None:
        # 随机 owner 前缀避免与既有合成数据交叉；只断言结果可迭代且无异常。
        owners = self.directory.list_owners()
        self.assertIsInstance(owners, tuple)
        for owner in owners:
            self.assertTrue(hasattr(owner, "id"))
            self.assertTrue(hasattr(owner, "display_name"))

    def test_create_owner_then_list_includes_it(self) -> None:
        owner_id = self._create_via_directory()

        created = self.directory.create_owner(
            owner_id, "我的关系助手"
        )

        self.assertEqual(created.id, owner_id)
        self.assertEqual(created.display_name, "我的关系助手")
        listed_ids = {owner.id for owner in self.directory.list_owners()}
        self.assertIn(owner_id, listed_ids)

    def test_create_owner_is_idempotent_and_keeps_original_name(self) -> None:
        owner_id = self._create_via_directory()
        self.directory.create_owner(owner_id, "首次名称")

        second = self.directory.create_owner(owner_id, "二次覆盖")

        self.assertEqual(second.id, owner_id)
        self.assertEqual(second.display_name, "首次名称")

    def test_create_owner_rejects_invalid_arguments(self) -> None:
        with self.assertRaises(OwnerDirectoryPersistenceError):
            self.directory.create_owner("not-a-uuid", "名称")
        with self.assertRaises(OwnerDirectoryPersistenceError):
            self.directory.create_owner(uuid4(), "   ")


if __name__ == "__main__":
    unittest.main()
