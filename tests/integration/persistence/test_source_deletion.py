"""PostgreSQL 来源删除与不可检索验证。"""

from __future__ import annotations

import os
import unittest
from pathlib import Path
from uuid import uuid4

import psycopg

from notalone.ingest.jsonl_reader import read_jsonl
from notalone.ingest.models import (
    ExistingContactSelection,
    ImportConfirmationRequest,
)
from notalone.ingest.normalizer import normalize_document
from notalone.persistence.postgres_repository import PostgresIngestRepository
from notalone.persistence.source_deletion import (
    PostgresSourceDeletionRepository,
    SourceDeletionError,
    SourceNotFoundError,
)


FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures"
TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class PostgresSourceDeletionRepositoryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            database_name = connection.execute("SELECT current_database()").fetchone()[0]
        if not database_name.endswith("_test"):
            raise RuntimeError("集成测试只允许连接名称以 _test 结尾的数据库。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "合成删除用户"),
            )
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) "
                "VALUES (%s, %s, %s)",
                (self.owner_id, self.contact_id, "合成删除联系人"),
            )
            connection.execute(
                "INSERT INTO public.owner_channel_identity "
                "(owner_id, channel, external_id, observed_name) "
                "VALUES (%s, 'wechat', %s, %s)",
                (self.owner_id, "wxid_synthetic_owner", "合成删除用户"),
            )
        self.ingest_repository = PostgresIngestRepository(TEST_DATABASE_URL)
        self.deletion_repository = PostgresSourceDeletionRepository(TEST_DATABASE_URL)
        self.batch = normalize_document(
            read_jsonl(FIXTURES_DIR / "valid_single_contact.jsonl")
        )

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )

    def test_delete_source_removes_all_retrievable_content(self) -> None:
        imported = self.ingest_repository.import_document(
            owner_id=self.owner_id,
            document=self.batch,
            confirmation=ImportConfirmationRequest(
                selection=ExistingContactSelection(contact_id=self.contact_id)
            ),
        )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            message_ids = tuple(
                row[0]
                for row in connection.execute(
                    "SELECT id FROM public.message WHERE source_document_id = %s",
                    (imported.source_document_id,),
                ).fetchall()
            )

        result = self.deletion_repository.delete_source(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            source_document_id=imported.source_document_id,
        )

        self.assertEqual(result.outcome, "deleted")
        self.assertIsNotNone(result.deleted_at)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            source = connection.execute(
                """
                SELECT status, file_name, content_sha256, record_count, deleted_at
                FROM public.source_document
                WHERE owner_id = %s AND contact_id = %s AND id = %s
                """,
                (self.owner_id, self.contact_id, imported.source_document_id),
            ).fetchone()
            remaining = connection.execute(
                """
                SELECT
                    (SELECT count(*) FROM public.message
                     WHERE owner_id = %s AND contact_id = %s
                       AND source_document_id = %s),
                    (SELECT count(*) FROM public.message WHERE id = ANY(%s::uuid[])),
                    (SELECT count(*) FROM public.wechat_message_metadata
                     WHERE source_document_id = %s),
                    (SELECT count(*) FROM public.import_confirmation
                     WHERE source_document_id = %s)
                """,
                (
                    self.owner_id,
                    self.contact_id,
                    imported.source_document_id,
                    list(message_ids),
                    imported.source_document_id,
                    imported.source_document_id,
                ),
            ).fetchone()

        self.assertEqual(source[:4], ("deleted", None, None, 0))
        self.assertIsNotNone(source[4])
        self.assertEqual(remaining, (0, 0, 0, 0))

    def test_delete_failure_is_recorded_without_losing_content(self) -> None:
        imported = self.ingest_repository.import_document(
            owner_id=self.owner_id,
            document=self.batch,
            confirmation=ImportConfirmationRequest(
                selection=ExistingContactSelection(contact_id=self.contact_id)
            ),
        )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                """
                CREATE FUNCTION public.block_synthetic_message_delete()
                RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    RAISE EXCEPTION 'synthetic deletion failure';
                END
                $$
                """
            )
            connection.execute(
                """
                CREATE TRIGGER block_synthetic_message_delete
                BEFORE DELETE ON public.message
                FOR EACH ROW EXECUTE FUNCTION public.block_synthetic_message_delete()
                """
            )

        try:
            with self.assertRaises(SourceDeletionError):
                self.deletion_repository.delete_source(
                    owner_id=self.owner_id,
                    contact_id=self.contact_id,
                    source_document_id=imported.source_document_id,
                )
        finally:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                connection.execute(
                    "DROP TRIGGER block_synthetic_message_delete ON public.message"
                )
                connection.execute(
                    "DROP FUNCTION public.block_synthetic_message_delete()"
                )

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            source = connection.execute(
                """
                SELECT status, deletion_error_code
                FROM public.source_document
                WHERE id = %s
                """,
                (imported.source_document_id,),
            ).fetchone()
            message_count = connection.execute(
                "SELECT count(*) FROM public.message WHERE source_document_id = %s",
                (imported.source_document_id,),
            ).fetchone()[0]

        self.assertEqual(source, ("delete_failed", "storage_delete_failed"))
        self.assertEqual(message_count, 6)

    def test_delete_source_is_idempotent(self) -> None:
        imported = self.ingest_repository.import_document(
            owner_id=self.owner_id,
            document=self.batch,
            confirmation=ImportConfirmationRequest(
                selection=ExistingContactSelection(contact_id=self.contact_id)
            ),
        )

        first = self.deletion_repository.delete_source(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            source_document_id=imported.source_document_id,
        )
        second = self.deletion_repository.delete_source(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            source_document_id=imported.source_document_id,
        )

        self.assertEqual(first.outcome, "deleted")
        self.assertEqual(second.outcome, "already_deleted")
        self.assertEqual(second.source_document_id, first.source_document_id)
        self.assertEqual(second.deleted_at, first.deleted_at)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            state = connection.execute(
                """
                SELECT status,
                       (SELECT count(*) FROM public.message
                        WHERE source_document_id = %s)
                FROM public.source_document
                WHERE id = %s
                """,
                (imported.source_document_id, imported.source_document_id),
            ).fetchone()
        self.assertEqual(state, ("deleted", 0))

    def test_deleted_file_is_reimported_as_a_new_source(self) -> None:
        confirmation = ImportConfirmationRequest(
            selection=ExistingContactSelection(contact_id=self.contact_id)
        )
        first = self.ingest_repository.import_document(
            owner_id=self.owner_id,
            document=self.batch,
            confirmation=confirmation,
        )
        self.deletion_repository.delete_source(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            source_document_id=first.source_document_id,
        )

        second = self.ingest_repository.import_document(
            owner_id=self.owner_id,
            document=self.batch,
            confirmation=confirmation,
        )

        self.assertEqual(second.outcome, "imported")
        self.assertNotEqual(first.source_document_id, second.source_document_id)
        self.assertNotEqual(first.confirmation_id, second.confirmation_id)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            sources = connection.execute(
                """
                SELECT id, status
                FROM public.source_document
                WHERE owner_id = %s AND contact_id = %s
                ORDER BY imported_at, id
                """,
                (self.owner_id, self.contact_id),
            ).fetchall()
            message_count = connection.execute(
                "SELECT count(*) FROM public.message WHERE source_document_id = %s",
                (second.source_document_id,),
            ).fetchone()[0]

        self.assertEqual(set(sources), {
            (first.source_document_id, "deleted"),
            (second.source_document_id, "active"),
        })
        self.assertEqual(message_count, 6)

    def test_wrong_contact_cannot_delete_source(self) -> None:
        imported = self.ingest_repository.import_document(
            owner_id=self.owner_id,
            document=self.batch,
            confirmation=ImportConfirmationRequest(
                selection=ExistingContactSelection(contact_id=self.contact_id)
            ),
        )

        with self.assertRaises(SourceNotFoundError):
            self.deletion_repository.delete_source(
                owner_id=self.owner_id,
                contact_id=uuid4(),
                source_document_id=imported.source_document_id,
            )

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            state = connection.execute(
                """
                SELECT status,
                       (SELECT count(*) FROM public.message
                        WHERE source_document_id = %s)
                FROM public.source_document
                WHERE id = %s
                """,
                (imported.source_document_id, imported.source_document_id),
            ).fetchone()
        self.assertEqual(state, ("active", 6))


if __name__ == "__main__":
    unittest.main()
