"""PostgreSQL 消息检索的联系人范围集成测试。"""

from __future__ import annotations

import os
import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg

from notalone.persistence import PostgresRetrieval
from notalone.retrieval import RetrievalError
from notalone.scopes import ContactScope


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class PostgresRetrievalTest(unittest.TestCase):
    """只使用合成 owner、联系人、来源和消息。"""

    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
                has_table = connection.execute(
                    "SELECT to_regclass('public.message')"
                ).fetchone()[0]
                has_current_schema = connection.execute(
                    """
                    SELECT EXISTS (
                        SELECT 1
                        FROM information_schema.columns
                        WHERE table_schema = 'public'
                          AND table_name = 'message'
                          AND column_name = 'media_placeholder'
                    )
                    AND to_regclass('public.wechat_message_metadata') IS NOT NULL
                    """
                ).fetchone()[0]
        except psycopg.OperationalError as error:
            raise unittest.SkipTest("本地 PostgreSQL 测试库不可用。") from error

        if not database_name.endswith("_test"):
            raise RuntimeError("集成测试只允许连接名称以 _test 结尾的数据库。")
        if has_table is None:
            raise unittest.SkipTest("测试库尚未应用消息表迁移。")
        if not has_current_schema:
            raise unittest.SkipTest("测试库尚未应用 004-005 消息与来源迁移。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        self.other_contact_id = uuid4()
        self.other_owner_id = uuid4()
        self.other_owner_contact_id = uuid4()
        self.source_id = uuid4()
        self.other_source_id = uuid4()
        self.other_owner_source_id = uuid4()
        self.deleted_source_id = uuid4()
        self.target_message_id = uuid4()
        self.recent_message_id = uuid4()
        self.older_message_id = uuid4()
        self.media_message_id = uuid4()
        self.other_contact_message_id = uuid4()
        self.other_owner_message_id = uuid4()
        self.deleted_message_id = uuid4()

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            with connection.cursor() as cursor:
                cursor.executemany(
                    "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                    (
                        (self.owner_id, "合成检索用户"),
                        (self.other_owner_id, "另一个合成用户"),
                    ),
                )
                cursor.executemany(
                    "INSERT INTO public.contact (owner_id, id, display_name) "
                    "VALUES (%s, %s, %s)",
                    (
                        (self.owner_id, self.contact_id, "合成联系人甲"),
                        (self.owner_id, self.other_contact_id, "合成联系人乙"),
                        (
                            self.other_owner_id,
                            self.other_owner_contact_id,
                            "另一个合成联系人",
                        ),
                    ),
                ),
            self._insert_source(connection, self.source_id, "active", "a")
            self._insert_source(
                connection,
                self.other_source_id,
                "active",
                "b",
                contact_id=self.other_contact_id,
            )
            self._insert_source(
                connection,
                self.other_owner_source_id,
                "active",
                "d",
                owner_id=self.other_owner_id,
                contact_id=self.other_owner_contact_id,
            )
            self._insert_source(
                connection,
                self.deleted_source_id,
                "delete_failed",
                "c",
            )
            self._insert_message(
                connection,
                self.target_message_id,
                self.source_id,
                "目标消息本身",
                datetime(2026, 8, 20, 9, 0, tzinfo=timezone.utc),
            )
            self._insert_message(
                connection,
                self.recent_message_id,
                self.source_id,
                "最近讨论明天见面",
                datetime(2026, 8, 21, 9, 0, tzinfo=timezone.utc),
            )
            self._insert_message(
                connection,
                self.older_message_id,
                self.source_id,
                "之前说过明天见面",
                datetime(2026, 8, 19, 9, 0, tzinfo=timezone.utc),
            )
            self._insert_message(
                connection,
                self.media_message_id,
                self.source_id,
                "",
                datetime(2026, 8, 18, 9, 0, tzinfo=timezone.utc),
                media_placeholder="[图片]",
            )
            self._insert_message(
                connection,
                self.other_contact_message_id,
                self.other_source_id,
                "最近讨论明天见面",
                datetime(2026, 8, 22, 9, 0, tzinfo=timezone.utc),
                contact_id=self.other_contact_id,
            )
            self._insert_message(
                connection,
                self.other_owner_message_id,
                self.other_owner_source_id,
                "最近讨论明天见面",
                datetime(2026, 8, 23, 9, 0, tzinfo=timezone.utc),
                owner_id=self.other_owner_id,
                contact_id=self.other_owner_contact_id,
            )
            self._insert_message(
                connection,
                self.deleted_message_id,
                self.deleted_source_id,
                "删除来源中的明天消息",
                datetime(2026, 8, 24, 9, 0, tzinfo=timezone.utc),
            )

        self.port = PostgresRetrieval(TEST_DATABASE_URL)

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id IN (%s, %s)",
                (self.owner_id, self.other_owner_id),
            )

    def _scope(self, contact_id: UUID | None = None) -> ContactScope:
        return ContactScope(self.owner_id, contact_id or self.contact_id)

    def _insert_source(
        self,
        connection: psycopg.Connection,
        source_id: UUID,
        status: str,
        digest_letter: str,
        *,
        owner_id: UUID | None = None,
        contact_id: UUID | None = None,
    ) -> None:
        connection.execute(
            """
            INSERT INTO public.source_document (
                id, owner_id, contact_id, source_type, file_name,
                content_sha256, record_count, status
            )
            VALUES (%s, %s, %s, 'wechat_jsonl', %s, %s, 1, %s)
            """,
            (
                source_id,
                owner_id or self.owner_id,
                contact_id or self.contact_id,
                f"synthetic-{digest_letter}.jsonl",
                digest_letter * 64,
                status,
            ),
        )

    def _insert_message(
        self,
        connection: psycopg.Connection,
        message_id: UUID,
        source_id: UUID,
        text: str,
        occurred_at: datetime,
        *,
        media_placeholder: str | None = None,
        owner_id: UUID | None = None,
        contact_id: UUID | None = None,
    ) -> None:
        connection.execute(
            """
            INSERT INTO public.message (
                id, owner_id, contact_id,
                speaker, message_type, text_content, media_placeholder,
                occurred_at
            )
            VALUES (%s, %s, %s, 'contact', %s, %s, %s, %s)
            """,
            (
                message_id,
                owner_id or self.owner_id,
                contact_id or self.contact_id,
                "image" if media_placeholder else "text",
                text,
                media_placeholder,
                occurred_at,
            ),
        )
        connection.execute(
            """
            INSERT INTO public.message_source_ref (
                id, message_id, owner_id, contact_id,
                source_kind, source_document_id, source_locator, raw_payload
            )
            VALUES (gen_random_uuid(), %s, %s, %s, 'source_document', %s, %s,
                    '{}'::jsonb)
            """,
            (
                message_id,
                owner_id or self.owner_id,
                contact_id or self.contact_id,
                source_id,
                f"synthetic:{message_id}",
            ),
        )

    def test_search_messages_filters_scope_source_and_all_query_terms(self) -> None:
        results = self.port.search_messages(
            scope=self._scope(),
            query="最近 明天",
        )

        self.assertEqual(
            tuple(item.message_id for item in results),
            (self.recent_message_id,),
        )
        self.assertEqual(results[0].scope, self._scope())
        self.assertEqual(results[0].source_ids, (self.source_id,))

        self.assertEqual(
            self.port.search_messages(scope=self._scope(), query="删除来源"),
            (),
        )
        self.assertEqual(
            self.port.search_messages(
                scope=ContactScope(self.owner_id, self.other_contact_id),
                query="最近 明天",
            )[0].message_id,
            self.other_contact_message_id,
        )
        self.assertEqual(
            self.port.search_messages(
                scope=ContactScope(
                    self.other_owner_id,
                    self.other_owner_contact_id,
                ),
                query="最近 明天",
            )[0].message_id,
            self.other_owner_message_id,
        )

    def test_target_message_is_returned_first_and_limit_is_applied(self) -> None:
        results = self.port.search_messages(
            scope=self._scope(),
            target_message_id=self.target_message_id,
            query="明天",
            limit=2,
        )

        self.assertEqual(
            tuple(item.message_id for item in results),
            (self.target_message_id, self.recent_message_id),
        )

    def test_unfiltered_messages_are_returned_in_recent_first_order(self) -> None:
        results = self.port.search_messages(scope=self._scope(), limit=4)

        self.assertEqual(
            tuple(item.message_id for item in results),
            (
                self.recent_message_id,
                self.target_message_id,
                self.older_message_id,
                self.media_message_id,
            ),
        )

    def test_media_placeholder_is_the_retrieved_text(self) -> None:
        results = self.port.search_messages(
            scope=self._scope(),
            query="图片",
        )

        self.assertEqual(tuple(item.message_id for item in results), (self.media_message_id,))
        self.assertEqual(results[0].text, "[图片]")

    def test_invalid_limit_is_rejected_before_database_query(self) -> None:
        with self.assertRaises(ValueError):
            self.port.search_messages(scope=self._scope(), limit=0)

    def test_memory_search_returns_empty_without_confirmed_memory(self) -> None:
        self.assertEqual(
            self.port.search_confirmed_memories(scope=self._scope()),
            (),
        )

    def test_database_failure_is_exposed_as_stable_retrieval_error(self) -> None:
        with patch(
            "notalone.persistence.retrieval.psycopg.connect",
            side_effect=psycopg.OperationalError("synthetic connection detail"),
        ):
            with self.assertRaises(RetrievalError) as raised:
                self.port.search_messages(scope=self._scope())

        self.assertEqual(str(raised.exception), "消息检索失败。")


if __name__ == "__main__":
    unittest.main()
