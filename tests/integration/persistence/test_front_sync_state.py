"""前台同步开关状态持久化测试。"""

from __future__ import annotations

import os
import unittest
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import psycopg

from notalone.persistence.front_sync_state import (
    FrontSyncStatePersistenceError,
    PostgresFrontSyncStateStore,
)


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class PostgresFrontSyncStateStoreTest(unittest.TestCase):
    """只验证合成 owner 的开关状态，不连接微信或读取聊天内容。"""

    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
                has_table = connection.execute(
                    """
                    SELECT 1
                    FROM information_schema.tables
                    WHERE table_schema = 'public'
                      AND table_name = 'front_sync_state'
                    """
                ).fetchone()
        except psycopg.OperationalError as error:
            raise unittest.SkipTest(
                "本地 PostgreSQL 测试库不可用。"
            ) from error

        if not database_name.endswith("_test"):
            raise RuntimeError(
                "集成测试只允许连接名称以 _test 结尾的数据库。"
            )
        if has_table is None:
            raise unittest.SkipTest("测试库尚未应用 022 同步开关迁移。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "同步开关用户"),
            )
        self.store = PostgresFrontSyncStateStore(TEST_DATABASE_URL)

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )

    def test_default_state_is_disabled_without_toggle_times(self) -> None:
        state = self.store.read(owner_id=self.owner_id)

        self.assertEqual(state.owner_id, self.owner_id)
        self.assertFalse(state.enabled)
        self.assertIsNone(state.enabled_at)
        self.assertIsNone(state.disabled_at)

    def test_enable_then_disable_records_toggle_times(self) -> None:
        enabled_at = datetime(2026, 8, 24, 9, 0, tzinfo=timezone.utc)
        disabled_at = enabled_at + timedelta(hours=1)

        enabled = self.store.enable(owner_id=self.owner_id, at=enabled_at)
        self.assertTrue(enabled.enabled)
        self.assertEqual(enabled.enabled_at, enabled_at)
        self.assertIsNone(enabled.disabled_at)

        disabled = self.store.disable(owner_id=self.owner_id, at=disabled_at)
        self.assertFalse(disabled.enabled)
        self.assertEqual(disabled.enabled_at, enabled_at)
        self.assertEqual(disabled.disabled_at, disabled_at)

        reread = self.store.read(owner_id=self.owner_id)
        self.assertFalse(reread.enabled)
        self.assertEqual(reread.disabled_at, disabled_at)

    def test_default_toggle_time_uses_database_now(self) -> None:
        state = self.store.enable(owner_id=self.owner_id)

        self.assertIsNotNone(state.enabled_at)

    def test_repeat_toggle_moves_only_matching_timestamp(self) -> None:
        first_disable = datetime(2026, 8, 24, 9, 0, tzinfo=timezone.utc)
        self.store.disable(owner_id=self.owner_id, at=first_disable)
        again = self.store.disable(
            owner_id=self.owner_id,
            at=first_disable + timedelta(minutes=10),
        )
        # 重复关闭只更新关闭时间，不产生开启时间。
        self.assertIsNone(again.enabled_at)
        self.assertEqual(
            again.disabled_at, first_disable + timedelta(minutes=10)
        )

        enabled = self.store.enable(owner_id=self.owner_id)
        self.assertTrue(enabled.enabled)
        self.assertEqual(enabled.disabled_at, again.disabled_at)

    def test_repeat_enable_keeps_original_enabled_at(self) -> None:
        first_enable = datetime(2026, 8, 24, 9, 0, tzinfo=timezone.utc)
        self.store.enable(owner_id=self.owner_id, at=first_enable)
        self.store.disable(owner_id=self.owner_id)
        reopened_at = first_enable + timedelta(minutes=30)
        reopened = self.store.enable(owner_id=self.owner_id, at=reopened_at)

        again = self.store.enable(
            owner_id=self.owner_id,
            at=reopened_at + timedelta(minutes=10),
        )

        # 同步本已开启时重复开启不移动开启时间；否则关闭窗口会被
        # 扩大到同步已开启的区间，旧前台引擎会永久过滤其中的消息。
        self.assertTrue(again.enabled)
        self.assertEqual(again.enabled_at, reopened_at)
        self.assertEqual(again.disabled_at, reopened.disabled_at)

    def test_state_survives_restart_with_new_store_instance(self) -> None:
        self.store.enable(owner_id=self.owner_id)

        recovered = PostgresFrontSyncStateStore(TEST_DATABASE_URL)
        state = recovered.read(owner_id=self.owner_id)
        self.assertTrue(state.enabled)

    def test_owner_deletion_cascades_state(self) -> None:
        self.store.enable(owner_id=self.owner_id)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )

        # owner 不存在时读取回到默认关闭状态，不抛错。
        state = self.store.read(owner_id=self.owner_id)
        self.assertFalse(state.enabled)
        # 面向已删除 owner 的开关写入必须失败关闭。
        with self.assertRaises(FrontSyncStatePersistenceError):
            self.store.enable(owner_id=self.owner_id)

    def test_invalid_owner_id_is_rejected(self) -> None:
        with self.assertRaises(TypeError):
            self.store.read(owner_id="not-a-uuid")  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
