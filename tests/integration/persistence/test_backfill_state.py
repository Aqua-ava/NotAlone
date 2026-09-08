"""CLI 后台补齐状态持久化测试。"""

from __future__ import annotations

import os
import unittest
from datetime import datetime, timezone
from uuid import uuid4

import psycopg

from notalone.persistence.backfill_state import (
    BackfillPhase,
    BackfillStatePersistenceError,
    PostgresBackfillStateStore,
)
from notalone.persistence.conversation_repository import (
    PostgresConversationBindingRepository,
)


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class PostgresBackfillStateStoreTest(unittest.TestCase):
    """只验证补齐元数据，不写入或读取聊天正文。"""

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
                      AND table_name = 'cli_backfill_state'
                    """
                ).fetchone()
        except psycopg.OperationalError as error:
            raise unittest.SkipTest("本地 PostgreSQL 测试库不可用。") from error
        if not database_name.endswith("_test"):
            raise RuntimeError("集成测试只允许连接名称以 _test 结尾的数据库。")
        if has_table is None:
            raise unittest.SkipTest("测试库尚未应用 029 补齐状态迁移。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        self.binding_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "补齐状态用户"),
            )
            connection.execute(
                """
                INSERT INTO public.contact (owner_id, id, display_name)
                VALUES (%s, %s, %s)
                """,
                (self.owner_id, self.contact_id, "合成联系人"),
            )
        self.bindings = PostgresConversationBindingRepository(TEST_DATABASE_URL)
        self.bindings.create_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="wxid_backfill",
        )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                """
                UPDATE public.conversation_binding
                SET id = %s
                WHERE owner_id = %s AND contact_id = %s
                """,
                (self.binding_id, self.owner_id, self.contact_id),
            )
        self.store = PostgresBackfillStateStore(TEST_DATABASE_URL)

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )

    def test_state_survives_store_restart_and_complete_is_explicit(self) -> None:
        trigger_at = datetime(2026, 9, 8, 10, 0, tzinfo=timezone.utc)

        started = self.store.ensure_started(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            binding_id=self.binding_id,
            trigger_at=trigger_at,
        )
        self.assertEqual(started.phase, BackfillPhase.GAP_DETECTED)

        running = self.store.mark_running(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            binding_id=self.binding_id,
        )
        self.assertEqual(running.phase, BackfillPhase.BACKFILLING)

        complete = self.store.mark_complete(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            binding_id=self.binding_id,
            message_count=2,
            last_local_id=12,
            last_cursor="local_id:12",
        )
        self.assertEqual(complete.phase, BackfillPhase.COMPLETE)
        self.assertEqual(complete.message_count, 2)

        recovered = PostgresBackfillStateStore(TEST_DATABASE_URL).read(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            binding_id=self.binding_id,
        )
        self.assertIsNotNone(recovered)
        self.assertEqual(recovered.phase, BackfillPhase.COMPLETE)
        self.assertEqual(recovered.last_cursor, "local_id:12")

    def test_failed_state_has_no_completed_timestamp(self) -> None:
        self.store.ensure_started(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            binding_id=self.binding_id,
            trigger_at=datetime.now(timezone.utc),
        )
        failed = self.store.mark_failed(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            binding_id=self.binding_id,
            failure_code="cli_command_failed",
        )

        self.assertEqual(failed.phase, BackfillPhase.FAILED)
        self.assertEqual(failed.failure_code, "cli_command_failed")
        self.assertIsNone(failed.completed_at)

    def test_pause_retry_and_incomplete_states_survive_restart(self) -> None:
        trigger_at = datetime(2026, 9, 8, 11, 0, tzinfo=timezone.utc)
        self.store.ensure_started(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            binding_id=self.binding_id,
            trigger_at=trigger_at,
        )

        paused = self.store.mark_paused(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            binding_id=self.binding_id,
        )
        self.assertEqual(paused.phase, BackfillPhase.PAUSED)
        self.assertIsNone(paused.completed_at)

        reopened = PostgresBackfillStateStore(TEST_DATABASE_URL).ensure_started(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            binding_id=self.binding_id,
            trigger_at=datetime(2026, 9, 8, 11, 1, tzinfo=timezone.utc),
        )
        self.assertEqual(reopened.phase, BackfillPhase.PAUSED)

        retried = self.store.mark_retry(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            binding_id=self.binding_id,
            trigger_at=trigger_at,
        )
        self.assertEqual(retried.phase, BackfillPhase.GAP_DETECTED)
        self.assertIsNone(retried.failure_code)

        incomplete = self.store.mark_incomplete(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            binding_id=self.binding_id,
            failure_code="cli_unavailable",
        )
        self.assertEqual(incomplete.phase, BackfillPhase.INCOMPLETE)
        self.assertIsNone(incomplete.completed_at)

        listed = self.store.list_active(
            owner_id=self.owner_id,
            channel="wechat",
            account_scope="synthetic-account",
        )
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0].phase, BackfillPhase.INCOMPLETE)

    def test_revoked_binding_cannot_start_backfill_state(self) -> None:
        self.bindings.revoke_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            binding_id=self.binding_id,
        )

        with self.assertRaises(BackfillStatePersistenceError):
            self.store.ensure_started(
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                binding_id=self.binding_id,
                trigger_at=datetime.now(timezone.utc),
            )

    def test_state_binding_must_match_owner_and_contact_scope(self) -> None:
        other_contact_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) "
                "VALUES (%s, %s, %s)",
                (self.owner_id, other_contact_id, "另一联系人"),
            )
        other_binding = self.bindings.create_binding(
            owner_id=self.owner_id,
            contact_id=other_contact_id,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="wxid_other_backfill",
        )

        with self.assertRaises(psycopg.errors.ForeignKeyViolation):
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                connection.execute(
                    """
                    INSERT INTO public.cli_backfill_state (
                        owner_id, contact_id, binding_id, phase, trigger_at
                    )
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (
                        self.owner_id,
                        self.contact_id,
                        other_binding.binding_id,
                        BackfillPhase.GAP_DETECTED.value,
                        datetime.now(timezone.utc),
                    ),
                )


if __name__ == "__main__":
    unittest.main()
