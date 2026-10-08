"""提取水位与失败恢复状态的 PostgreSQL 持久化测试。"""

from __future__ import annotations

import os
import unittest
from uuid import uuid4

import psycopg

from notalone.memory_extraction.models import ExtractionFailureKind
from notalone.memory_extraction.recovery import (
    ExtractionFailureState,
    FailureRange,
)
from notalone.persistence.watermark_store import PostgresWatermarkStore
from notalone.scopes import ContactScope


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class PostgresWatermarkStoreTest(unittest.TestCase):
    """只验证水位与失败状态，不涉及消息或记忆正文。"""

    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
                has_column = connection.execute(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'memory_extraction_watermark'
                      AND column_name = 'failure_count'
                    """
                ).fetchone()
        except psycopg.OperationalError as error:
            raise unittest.SkipTest("本地 PostgreSQL 测试库不可用。") from error
        if not database_name.endswith("_test"):
            raise RuntimeError("集成测试只允许连接名称以 _test 结尾的数据库。")
        if has_column is None:
            raise unittest.SkipTest("测试库尚未应用 034 提取失败恢复迁移。")

    def setUp(self) -> None:
        # 035 之后水位行按 (owner_id, contact_id) 外键级联于 contact；
        # 测试必须使用真实存在的 owner 与联系人。
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        self.scope = ContactScope(self.owner_id, self.contact_id)
        self.store = PostgresWatermarkStore(TEST_DATABASE_URL)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "水位合成用户"),
            )
            connection.execute(
                """
                INSERT INTO public.contact (owner_id, id, display_name)
                VALUES (%s, %s, %s)
                """,
                (self.owner_id, self.contact_id, "水位合成联系人"),
            )
            connection.commit()
        self.addCleanup(self._cleanup)

    def _cleanup(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )
            connection.commit()

    @staticmethod
    def _range(from_id, to_id) -> FailureRange:
        return FailureRange(
            from_message_id=from_id,
            to_message_id=to_id,
            code=ExtractionFailureKind.INVALID_OUTPUT,
        )

    def test_success_advance_clears_counting_state(self) -> None:
        from_id, to_id = uuid4(), uuid4()
        self.store.save_failure(
            self.scope,
            ExtractionFailureState(
                count=2,
                failure_range=self._range(from_id, to_id),
            ),
        )

        self.store.set(self.scope, to_id)

        self.assertEqual(self.store.get(self.scope), to_id)
        self.assertIsNone(self.store.get_failure(self.scope))

    def test_counting_state_round_trips(self) -> None:
        from_id, to_id = uuid4(), uuid4()
        state = ExtractionFailureState(
            count=1,
            failure_range=self._range(from_id, to_id),
        )

        self.store.save_failure(self.scope, state)

        self.assertEqual(self.store.get_failure(self.scope), state)
        self.assertIsNone(self.store.get(self.scope))

    def test_skip_records_range_and_advances_watermark(self) -> None:
        from_id, to_id = uuid4(), uuid4()

        self.store.mark_skipped(self.scope, self._range(from_id, to_id))

        self.assertEqual(self.store.get(self.scope), to_id)
        self.assertIsNone(self.store.get_failure(self.scope))
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            row = connection.execute(
                """
                SELECT last_skipped_from_id, last_skipped_to_id,
                       last_skipped_code, last_skipped_at
                FROM public.memory_extraction_watermark
                WHERE owner_id = %s AND contact_id = %s
                """,
                (self.scope.owner_id, self.scope.contact_id),
            ).fetchone()
        self.assertEqual(row[0], from_id)
        self.assertEqual(row[1], to_id)
        self.assertEqual(row[2], "invalid_output")
        self.assertIsNotNone(row[3])

    def test_skip_record_survives_later_success(self) -> None:
        from_id, to_id = uuid4(), uuid4()
        self.store.mark_skipped(self.scope, self._range(from_id, to_id))

        self.store.set(self.scope, uuid4())

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            row = connection.execute(
                """
                SELECT last_skipped_from_id, last_skipped_to_id
                FROM public.memory_extraction_watermark
                WHERE owner_id = %s AND contact_id = %s
                """,
                (self.scope.owner_id, self.scope.contact_id),
            ).fetchone()
        self.assertEqual(row[0], from_id)
        self.assertEqual(row[1], to_id)

    def test_missing_row_reads_as_none(self) -> None:
        self.assertIsNone(self.store.get(self.scope))
        self.assertIsNone(self.store.get_failure(self.scope))

    def test_watermark_row_cascades_with_owner_deletion(self) -> None:
        # 级联契约（035）：owner 被删除后水位行必须随之消失，不能
        # 留下无产品路径可清理的孤儿行。
        self.store.set(self.scope, uuid4())
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            row = connection.execute(
                """
                SELECT 1 FROM public.memory_extraction_watermark
                WHERE owner_id = %s AND contact_id = %s
                """,
                (self.owner_id, self.contact_id),
            ).fetchone()
        self.assertIsNotNone(row)

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )
            connection.commit()

        self.assertIsNone(self.store.get(self.scope))


if __name__ == "__main__":
    unittest.main()
