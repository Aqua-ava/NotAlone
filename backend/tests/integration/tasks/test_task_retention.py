"""后台任务终态留存与清理集成测试。"""

from __future__ import annotations

import os
import unittest
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import psycopg

from notalone.persistence.background_tasks import (
    PostgresBackgroundTaskRepository,
)


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class BackgroundTaskRetentionTest(unittest.TestCase):
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
        self.source_ids = (uuid4(), uuid4(), uuid4(), uuid4())
        self.task_ids = (uuid4(), uuid4(), uuid4(), uuid4())
        self.now = datetime(2026, 8, 23, tzinfo=timezone.utc)
        old = self.now - timedelta(days=91)
        recent = self.now - timedelta(days=1)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "合成留存用户"),
            )
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) "
                "VALUES (%s, %s, %s)",
                (self.owner_id, self.contact_id, "合成留存联系人"),
            )
            for index, source_id in enumerate(self.source_ids):
                connection.execute(
                    """
                    INSERT INTO public.source_document (
                        id, owner_id, contact_id, source_type, file_name,
                        content_sha256, record_count, status
                    ) VALUES (%s, %s, %s, 'wechat_jsonl', %s, %s, 0, 'active')
                    """,
                    (
                        source_id,
                        self.owner_id,
                        self.contact_id,
                        f"retention-{index}.jsonl",
                        f"{index + 1}" * 64,
                    ),
                )
            rows = (
                (self.task_ids[0], self.source_ids[0], "succeeded", old),
                (self.task_ids[1], self.source_ids[1], "failed", recent),
                (self.task_ids[2], self.source_ids[2], "queued", old),
                (self.task_ids[3], self.source_ids[3], "cancelled", old),
            )
            for task_id, source_id, status, finished_at in rows:
                connection.execute(
                    """
                    INSERT INTO public.background_task (
                        id, owner_id, contact_id, source_document_id,
                        task_type, status, current_step, message_count,
                        finished_at
                    ) VALUES (%s, %s, %s, %s, 'import', %s, 'verify', 0, %s)
                    """,
                    (
                        task_id,
                        self.owner_id,
                        self.contact_id,
                        source_id,
                        status,
                        finished_at,
                    ),
                )
                connection.execute(
                    """
                    INSERT INTO public.background_task_step (
                        task_id, step_name, step_order, status, finished_at
                    ) VALUES (%s, 'verify', 5, %s, %s)
                    """,
                    (
                        task_id,
                        "succeeded" if status != "queued" else "pending",
                        finished_at if status != "queued" else None,
                    ),
                )

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )

    def test_cleanup_deletes_only_old_terminal_task_metadata(self) -> None:
        repository = PostgresBackgroundTaskRepository(TEST_DATABASE_URL)

        deleted = repository.cleanup_terminal_tasks(now=self.now)

        self.assertEqual(deleted, 2)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            tasks = connection.execute(
                """
                SELECT id, status
                FROM public.background_task
                WHERE owner_id = %s
                ORDER BY id
                """,
                (self.owner_id,),
            ).fetchall()
            step_count = connection.execute(
                """
                SELECT count(*)
                FROM public.background_task_step
                WHERE task_id = %s
                """,
                (self.task_ids[0],),
            ).fetchone()[0]
            source_count = connection.execute(
                """
                SELECT count(*)
                FROM public.source_document
                WHERE owner_id = %s
                """,
                (self.owner_id,),
            ).fetchone()[0]

        self.assertEqual(
            {row[1] for row in tasks},
            {"failed", "queued"},
        )
        self.assertEqual(step_count, 0)
        self.assertEqual(source_count, 4)


if __name__ == "__main__":
    unittest.main()
