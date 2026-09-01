"""PostgreSQL SQL/全文检索的合成评测。"""

from __future__ import annotations

import os
import unittest
from dataclasses import replace
from uuid import UUID, uuid4

import psycopg

from notalone.persistence import PostgresRetrieval
from notalone.retrieval import (
    SyntheticRetrievalFixture,
    build_synthetic_retrieval_fixture,
    evaluate_retrieval,
)


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class PostgresRetrievalEvaluationTest(unittest.TestCase):
    """用随机 owner 和消息 ID，避免把个人资料带入评测。"""

    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
                has_schema = connection.execute(
                    """
                    SELECT to_regclass('public.owner') IS NOT NULL
                       AND to_regclass('public.contact') IS NOT NULL
                       AND to_regclass('public.source_document') IS NOT NULL
                       AND to_regclass('public.message') IS NOT NULL
                       AND to_regclass('public.message_source_ref') IS NOT NULL
                    """
                ).fetchone()[0]
        except psycopg.OperationalError as error:
            raise unittest.SkipTest(
                "本地 PostgreSQL 测试库不可用。"
            ) from error
        if not database_name.endswith("_test"):
            raise RuntimeError(
                "集成评测只允许连接名称以 _test 结尾的数据库。"
            )
        if not has_schema:
            raise unittest.SkipTest("测试库尚未应用检索相关迁移。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        self.other_contact_id = uuid4()
        fixture = build_synthetic_retrieval_fixture(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            other_contact_id=self.other_contact_id,
        )
        message_ids = {
            message.message_id: uuid4() for message in fixture.messages
        }
        current_source_id = uuid4()
        other_source_id = uuid4()
        messages = tuple(
            replace(
                message,
                message_id=message_ids[message.message_id],
                source_ids=(
                    current_source_id
                    if message.scope == fixture.scope
                    else other_source_id,
                ),
            )
            for message in fixture.messages
        )
        cases = tuple(
            replace(
                case,
                expected_message_ids=tuple(
                    message_ids[message_id]
                    for message_id in case.expected_message_ids
                ),
            )
            for case in fixture.cases
        )
        self.fixture = SyntheticRetrievalFixture(
            scope=fixture.scope,
            other_scope=fixture.other_scope,
            messages=messages,
            cases=cases,
        )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "合成评测用户"),
            )
            with connection.cursor() as cursor:
                cursor.executemany(
                    "INSERT INTO public.contact (owner_id, id, display_name) "
                    "VALUES (%s, %s, %s)",
                    (
                        (self.owner_id, self.contact_id, "合成评测联系人甲"),
                        (
                            self.owner_id,
                            self.other_contact_id,
                            "合成评测联系人乙",
                        ),
                    ),
                )
            self._insert_source(
                connection,
                current_source_id,
                self.contact_id,
                "a",
            )
            self._insert_source(
                connection,
                other_source_id,
                self.other_contact_id,
                "b",
            )
            for message in self.fixture.messages:
                connection.execute(
                    """
                    INSERT INTO public.message (
                        id, owner_id, contact_id, speaker, message_type,
                        text_content, media_placeholder, occurred_at
                    )
                    VALUES (%s, %s, %s, 'contact', 'text', %s, NULL, %s)
                    """,
                    (
                        message.message_id,
                        message.scope.owner_id,
                        message.scope.contact_id,
                        message.text,
                        message.occurred_at,
                    ),
                )
                connection.execute(
                    """
                    INSERT INTO public.message_source_ref (
                        id, message_id, owner_id, contact_id, source_kind,
                        source_document_id, source_locator, raw_payload
                    )
                    VALUES (gen_random_uuid(), %s, %s, %s,
                            'source_document', %s, %s, '{}'::jsonb)
                    """,
                    (
                        message.message_id,
                        message.scope.owner_id,
                        message.scope.contact_id,
                        message.source_ids[0],
                        f"synthetic:{message.message_id}",
                    ),
                )
        self.port = PostgresRetrieval(TEST_DATABASE_URL)

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )

    def _insert_source(
        self,
        connection: psycopg.Connection,
        source_id: UUID,
        contact_id: UUID,
        digest_letter: str,
    ) -> None:
        connection.execute(
            """
            INSERT INTO public.source_document (
                id, owner_id, contact_id, source_type, file_name,
                content_sha256, record_count, status
            )
            VALUES (%s, %s, %s, 'wechat_jsonl', %s, %s, 7, 'active')
            """,
            (
                source_id,
                self.owner_id,
                contact_id,
                f"synthetic-evaluation-{digest_letter}.jsonl",
                digest_letter * 64,
            ),
        )

    def test_evaluates_postgres_sql_fulltext_path_before_vector(self) -> None:
        report = evaluate_retrieval(
            self.port,
            self.fixture.cases,
            adapter_name="postgresql-sql-fulltext",
        )

        self.assertEqual(report.metrics.case_count, 6)
        self.assertEqual(report.metrics.empty_result_rate.numerator, 2)
        self.assertEqual(report.metrics.top_k_hit_rate.numerator, 5)
        self.assertEqual(report.metrics.fallback_rate.numerator, 0)
        self.assertEqual(
            report.vector_recommendation,
            "re_evaluate_before_vector",
        )
        self.assertFalse(report.vector_enabled)
        self.assertTrue(
            all(not item.foreign_message_ids for item in report.observations)
        )


if __name__ == "__main__":
    unittest.main()
