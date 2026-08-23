"""CLI 观察来源与联系人级水位的 PostgreSQL 持久化测试。"""

from __future__ import annotations

import os
import unittest
from uuid import uuid4

import psycopg

from notalone.persistence.conversation_repository import (
    PostgresConversationBindingRepository,
)
from notalone.persistence.observation_store import (
    ObservationMode,
    ObservationNotFoundError,
    ObservationWatermarkError,
    PostgresObservationStore,
)


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class PostgresObservationStoreTest(unittest.TestCase):
    """只验证合成观察元数据，不连接微信或读取聊天内容。"""

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
                      AND table_name = 'local_wechat_observation'
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
            raise unittest.SkipTest("测试库尚未应用 020 观察来源迁移。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_a = uuid4()
        self.contact_b = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "观察来源用户"),
            )
            with connection.cursor() as cursor:
                cursor.executemany(
                    "INSERT INTO public.contact (owner_id, id, display_name) "
                    "VALUES (%s, %s, %s)",
                    (
                        (self.owner_id, self.contact_a, "合成联系人甲"),
                        (self.owner_id, self.contact_b, "合成联系人乙"),
                    ),
                )
        bindings = PostgresConversationBindingRepository(TEST_DATABASE_URL)
        self.binding_a = bindings.create_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="wxid_observation_a",
        )
        self.binding_b = bindings.create_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_b,
            channel="wechat",
            account_scope="synthetic-account",
            conversation_locator="wxid_observation_b",
        )
        self.store = PostgresObservationStore(TEST_DATABASE_URL)

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )

    def _record(
        self,
        contact_id,
        binding_id,
        *,
        mode=ObservationMode.LIVE,
        since_local_id=None,
        last_local_id,
        locator="wxid_observation_a",
    ):
        return self.store.record_batch(
            owner_id=self.owner_id,
            contact_id=contact_id,
            binding_id=binding_id,
            mode=mode,
            cli_version="wechat-cli/0.1.0-test",
            conversation_locator=locator,
            since_local_id=since_local_id,
            last_local_id=last_local_id,
            last_cursor=f"cursor-{last_local_id}",
            record_count=3,
        )

    def test_first_read_has_no_cursor_and_zero_since_is_rejected(self) -> None:
        self.assertIsNone(
            self.store.read_cursor(
                owner_id=self.owner_id, contact_id=self.contact_a
            )
        )

        with self.assertRaises(ObservationWatermarkError):
            self.store.record_batch(
                owner_id=self.owner_id,
                contact_id=self.contact_a,
                binding_id=self.binding_a.binding_id,
                mode=ObservationMode.LIVE,
                cli_version="wechat-cli/0.1.0-test",
                conversation_locator="wxid_observation_a",
                since_local_id=0,
                last_local_id=5,
                last_cursor="cursor-5",
                record_count=3,
            )

    def test_cursors_are_contact_scoped_and_survive_restart(self) -> None:
        self._record(
            self.contact_a,
            self.binding_a.binding_id,
            last_local_id=10,
            locator="wxid_observation_a",
        )
        self._record(
            self.contact_b,
            self.binding_b.binding_id,
            last_local_id=42,
            locator="wxid_observation_b",
        )

        # 用新的 store 实例模拟进程重启后恢复水位。
        recovered = PostgresObservationStore(TEST_DATABASE_URL)
        cursor_a = recovered.read_cursor(
            owner_id=self.owner_id, contact_id=self.contact_a
        )
        cursor_b = recovered.read_cursor(
            owner_id=self.owner_id, contact_id=self.contact_b
        )

        self.assertEqual(cursor_a.last_local_id, 10)
        self.assertEqual(cursor_a.last_cursor, "cursor-10")
        self.assertEqual(cursor_a.binding_id, self.binding_a.binding_id)
        self.assertEqual(cursor_b.last_local_id, 42)
        self.assertEqual(cursor_b.conversation_locator, "wxid_observation_b")

    def test_switching_a_b_a_keeps_cursors_isolated_and_catchup_marked(self) -> None:
        first = self._record(
            self.contact_a,
            self.binding_a.binding_id,
            last_local_id=10,
            locator="wxid_observation_a",
        )
        self._record(
            self.contact_b,
            self.binding_b.binding_id,
            last_local_id=42,
            locator="wxid_observation_b",
        )

        catchup = self.store.record_batch(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            binding_id=self.binding_a.binding_id,
            mode=ObservationMode.CLI_CATCHUP,
            cli_version="wechat-cli/0.1.0-test",
            conversation_locator="wxid_observation_a",
            since_local_id=first.last_local_id,
            since_cursor=first.last_cursor,
            last_local_id=17,
            last_cursor="cursor-17",
            record_count=2,
        )

        self.assertEqual(catchup.mode, ObservationMode.CLI_CATCHUP)
        self.assertEqual(catchup.since_local_id, 10)
        cursor_a = self.store.read_cursor(
            owner_id=self.owner_id, contact_id=self.contact_a
        )
        cursor_b = self.store.read_cursor(
            owner_id=self.owner_id, contact_id=self.contact_b
        )
        self.assertEqual(cursor_a.last_local_id, 17)
        self.assertEqual(cursor_b.last_local_id, 42)

    def test_same_batch_retry_is_idempotent(self) -> None:
        first = self._record(
            self.contact_a,
            self.binding_a.binding_id,
            last_local_id=10,
            locator="wxid_observation_a",
        )
        cursor_before = self.store.read_cursor(
            owner_id=self.owner_id, contact_id=self.contact_a
        )

        retried = self.store.record_batch(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            binding_id=self.binding_a.binding_id,
            mode=ObservationMode.LIVE,
            cli_version="wechat-cli/0.1.0-test",
            conversation_locator="wxid_observation_a",
            last_local_id=10,
            last_cursor="cursor-10",
            record_count=3,
        )
        cursor_after = self.store.read_cursor(
            owner_id=self.owner_id, contact_id=self.contact_a
        )

        self.assertEqual(retried.observation_id, first.observation_id)
        self.assertEqual(cursor_before.updated_at, cursor_after.updated_at)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            (count,) = connection.execute(
                """
                SELECT count(*)
                FROM public.local_wechat_observation
                WHERE owner_id = %s AND contact_id = %s
                """,
                (self.owner_id, self.contact_a),
            ).fetchone()
        self.assertEqual(count, 1)

    def test_watermark_only_moves_forward(self) -> None:
        self._record(
            self.contact_a,
            self.binding_a.binding_id,
            last_local_id=10,
            locator="wxid_observation_a",
        )

        with self.assertRaises(ObservationWatermarkError):
            self.store.record_batch(
                owner_id=self.owner_id,
                contact_id=self.contact_a,
                binding_id=self.binding_a.binding_id,
                mode=ObservationMode.LIVE,
                cli_version="wechat-cli/0.1.0-test",
                conversation_locator="wxid_observation_a",
                since_local_id=3,
                last_local_id=8,
                last_cursor="cursor-8",
                record_count=1,
            )

    def test_revoked_or_foreign_binding_is_rejected(self) -> None:
        bindings = PostgresConversationBindingRepository(TEST_DATABASE_URL)
        bindings.revoke_binding(
            owner_id=self.owner_id,
            contact_id=self.contact_b,
            binding_id=self.binding_b.binding_id,
        )

        with self.assertRaises(ObservationNotFoundError):
            self._record(
                self.contact_b,
                self.binding_b.binding_id,
                last_local_id=5,
                locator="wxid_observation_b",
            )
        # 绑定与联系人范围不一致时同样拒绝。
        with self.assertRaises(ObservationNotFoundError):
            self._record(
                self.contact_a,
                self.binding_b.binding_id,
                last_local_id=6,
                locator="wxid_observation_b",
            )

    def test_delete_observation_is_scope_checked(self) -> None:
        recorded = self._record(
            self.contact_a,
            self.binding_a.binding_id,
            last_local_id=10,
            locator="wxid_observation_a",
        )

        with self.assertRaises(ObservationNotFoundError):
            self.store.delete_observation(
                owner_id=self.owner_id,
                contact_id=self.contact_b,
                observation_id=recorded.observation_id,
            )

        self.store.delete_observation(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            observation_id=recorded.observation_id,
        )
        # 来源删除不影响已成功推进的水位。
        cursor = self.store.read_cursor(
            owner_id=self.owner_id, contact_id=self.contact_a
        )
        self.assertEqual(cursor.last_local_id, 10)

    def test_binding_row_deletion_cascades_observation_and_cursor(self) -> None:
        self._record(
            self.contact_a,
            self.binding_a.binding_id,
            last_local_id=10,
            locator="wxid_observation_a",
        )

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.conversation_binding WHERE id = %s",
                (self.binding_a.binding_id,),
            )

        self.assertIsNone(
            self.store.read_cursor(
                owner_id=self.owner_id, contact_id=self.contact_a
            )
        )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            (count,) = connection.execute(
                """
                SELECT count(*)
                FROM public.local_wechat_observation
                WHERE owner_id = %s AND contact_id = %s
                """,
                (self.owner_id, self.contact_a),
            ).fetchone()
        self.assertEqual(count, 0)


if __name__ == "__main__":
    unittest.main()
