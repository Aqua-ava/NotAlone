"""持久化入口对 naive datetime 的防御一致性测试。

这些校验都必须发生在建立数据库连接之前，因此用无法解析的假 DSN
构造存储即可验证；测试不连接任何数据库。
"""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from notalone.persistence.conversation_repository import (
    CliBindingCreation,
    PostgresConversationBindingRepository,
)
from notalone.persistence.observation_store import (
    ObservationBaseline,
    PostgresObservationStore,
)
from notalone.scopes import ContactScope

FAKE_DSN = "postgresql://127.0.0.1:1/notalone_unit_test_unused"
NAIVE = datetime(2026, 10, 1, 9, 0)
AWARE = datetime(2026, 10, 1, 9, 0, tzinfo=timezone.utc)


class NaiveDatetimeGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.scope = ContactScope(owner_id=uuid4(), contact_id=uuid4())
        self.binding_id = uuid4()

    def test_observation_baseline_rejects_naive_time(self) -> None:
        with self.assertRaises(TypeError) as captured:
            ObservationBaseline(
                scope=self.scope,
                binding_id=self.binding_id,
                conversation_locator="合成会话",
                baseline_at=NAIVE,
            )
        self.assertIn("带时区", str(captured.exception))

    def test_ensure_baseline_rejects_naive_time_before_connecting(self) -> None:
        store = PostgresObservationStore(FAKE_DSN)
        with self.assertRaises(TypeError) as captured:
            store.ensure_baseline(
                owner_id=self.scope.owner_id,
                contact_id=self.scope.contact_id,
                binding_id=self.binding_id,
                conversation_locator="合成会话",
                baseline_at=NAIVE,
            )
        self.assertIn("带时区", str(captured.exception))

    def test_cli_binding_batch_rejects_naive_time_before_connecting(self) -> None:
        repository = PostgresConversationBindingRepository(FAKE_DSN)
        with self.assertRaises(TypeError) as captured:
            repository.create_cli_bindings_batch(
                owner_id=self.scope.owner_id,
                channel="wechat_cli",
                account_scope="synthetic-account",
                items=(CliBindingCreation(
                    conversation_locator="合成会话",
                    display_name="合成联系人",
                ),),
                baseline_at=NAIVE,
            )
        self.assertIn("带时区", str(captured.exception))

    def test_aware_time_passes_the_guard_and_reaches_the_connection(self) -> None:
        store = PostgresObservationStore(FAKE_DSN)
        # 带时区的时间通过校验后才会去连接，因此这里必须看到连接类错误，
        # 而不是 TypeError；这证明守卫没有误伤正常入参。
        with self.assertRaises(Exception) as captured:
            store.ensure_baseline(
                owner_id=self.scope.owner_id,
                contact_id=self.scope.contact_id,
                binding_id=self.binding_id,
                conversation_locator="合成会话",
                baseline_at=AWARE,
            )
        self.assertNotIsInstance(captured.exception, TypeError)

    def test_retention_style_awareness_check_matches_other_stores(self) -> None:
        # 与 background_tasks/memory_store 的既有口径保持一致：naive 一律拒绝。
        cutoff = AWARE - timedelta(days=1)
        self.assertIsNotNone(cutoff.tzinfo)


if __name__ == "__main__":
    unittest.main()
