"""PostgreSQL 聊天记录导入事务集成测试。"""

from __future__ import annotations

import os
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from threading import Barrier
from uuid import UUID, uuid4

import psycopg

from notalone.ingest.jsonl_reader import read_jsonl
from notalone.ingest.models import ImportBatch
from notalone.ingest.normalizer import normalize_document
from notalone.persistence.postgres_repository import (
    ImportPersistenceError,
    OverlappingSourceError,
    OwnerNotFoundError,
    PostgresIngestRepository,
    SourceStateConflictError,
)


FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures"
TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class PostgresIngestRepositoryTest(unittest.TestCase):
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
        self.repository = PostgresIngestRepository(TEST_DATABASE_URL)
        self.batch = self._load_batch()
        self.owner_ids: set[UUID] = set()

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            database_name = connection.execute(
                "SELECT current_database()"
            ).fetchone()[0]
            if not database_name.endswith("_test"):
                raise RuntimeError("拒绝清理非测试数据库。")
            for owner_id in self.owner_ids:
                connection.execute(
                    "DELETE FROM public.owner WHERE id = %s",
                    (owner_id,),
                )

    def test_imports_contact_source_and_messages_in_one_transaction(self) -> None:
        owner_id = self._create_owner("合成用户甲")

        result = self.repository.import_document(
            owner_id=owner_id,
            document=self.batch,
        )

        self.assertEqual(result.outcome, "imported")
        self.assertEqual(result.message_count, 6)
        self.assertEqual(self._count("contact", owner_id), 1)
        self.assertEqual(self._count("source_document", owner_id), 1)
        self.assertEqual(self._count("message", owner_id), 6)
        self.assertEqual(
            self._scalar(
                "SELECT speaker FROM public.message "
                "WHERE owner_id = %s AND external_local_id = 102",
                (owner_id,),
            ),
            "user",
        )

    def test_same_file_is_idempotent(self) -> None:
        owner_id = self._create_owner("合成用户甲")

        first = self.repository.import_document(owner_id=owner_id, document=self.batch)
        second = self.repository.import_document(owner_id=owner_id, document=self.batch)

        self.assertEqual(first.outcome, "imported")
        self.assertEqual(second.outcome, "already_imported")
        self.assertEqual(first.source_document_id, second.source_document_id)
        self.assertEqual(second.message_count, 6)
        self.assertEqual(self._count("source_document", owner_id), 1)
        self.assertEqual(self._count("message", owner_id), 6)

    def test_different_file_with_existing_local_ids_is_rejected(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        overlapping_batch = replace(
            self.batch,
            file_name="overlapping.jsonl",
            content_sha256="b" * 64,
        )
        self.repository.import_document(owner_id=owner_id, document=self.batch)

        with self.assertRaises(OverlappingSourceError):
            self.repository.import_document(
                owner_id=owner_id,
                document=overlapping_batch,
            )

        self.assertEqual(self._count("source_document", owner_id), 1)
        self.assertEqual(self._count("message", owner_id), 6)

    def test_concurrent_same_file_imports_only_one_source(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        worker_count = 4
        barrier = Barrier(worker_count)

        def import_same_document() -> str:
            barrier.wait()
            return self.repository.import_document(
                owner_id=owner_id,
                document=self.batch,
            ).outcome

        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            outcomes = list(executor.map(lambda _: import_same_document(), range(4)))

        self.assertEqual(outcomes.count("imported"), 1)
        self.assertEqual(outcomes.count("already_imported"), 3)
        self.assertEqual(self._count("source_document", owner_id), 1)
        self.assertEqual(self._count("message", owner_id), 6)

    def test_concurrent_overlapping_files_import_only_one_source(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        batches = (
            self.batch,
            replace(
                self.batch,
                file_name="overlapping.jsonl",
                content_sha256="c" * 64,
            ),
        )
        barrier = Barrier(2)

        def import_batch(batch: ImportBatch) -> str:
            barrier.wait()
            try:
                return self.repository.import_document(
                    owner_id=owner_id,
                    document=batch,
                ).outcome
            except OverlappingSourceError:
                return "overlap"

        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(import_batch, batches))

        self.assertEqual(outcomes.count("imported"), 1)
        self.assertEqual(outcomes.count("overlap"), 1)
        self.assertEqual(self._count("source_document", owner_id), 1)
        self.assertEqual(self._count("message", owner_id), 6)

    def test_existing_contact_display_name_is_not_overwritten(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) "
                "VALUES (%s, %s, %s)",
                (owner_id, self.batch.contact.contact_id, "人工修正名称"),
            )

        self.repository.import_document(owner_id=owner_id, document=self.batch)

        self.assertEqual(
            self._scalar(
                "SELECT display_name FROM public.contact "
                "WHERE owner_id = %s AND id = %s",
                (owner_id, self.batch.contact.contact_id),
            ),
            "人工修正名称",
        )

    def test_missing_owner_leaves_all_tables_unchanged(self) -> None:
        missing_owner_id = uuid4()
        with self.assertRaises(OwnerNotFoundError):
            self.repository.import_document(
                owner_id=missing_owner_id,
                document=self.batch,
            )

        self.assertEqual(self._count("owner", missing_owner_id), 0)
        self.assertEqual(self._count("contact", missing_owner_id), 0)
        self.assertEqual(self._count("source_document", missing_owner_id), 0)
        self.assertEqual(self._count("message", missing_owner_id), 0)

    def test_message_failure_rolls_back_contact_source_and_prior_messages(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        invalid_message = replace(self.batch.messages[1], speaker="invalid")
        invalid_batch = replace(
            self.batch,
            messages=(self.batch.messages[0], invalid_message),
        )

        with self.assertRaises(ImportPersistenceError) as raised:
            self.repository.import_document(owner_id=owner_id, document=invalid_batch)

        self.assertEqual(str(raised.exception), "数据库导入失败，未写入任何数据。")
        self.assertEqual(self._count("contact", owner_id), 0)
        self.assertEqual(self._count("source_document", owner_id), 0)
        self.assertEqual(self._count("message", owner_id), 0)

    def test_invalid_raw_payload_rolls_back_without_exposing_content(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        invalid_message = replace(
            self.batch.messages[0],
            raw_payload_json='{"private":"不应出现在错误信息中",',
        )
        invalid_batch = replace(self.batch, messages=(invalid_message,))

        with self.assertRaises(ImportPersistenceError) as raised:
            self.repository.import_document(
                owner_id=owner_id,
                document=invalid_batch,
            )

        self.assertEqual(str(raised.exception), "数据库导入失败，未写入任何数据。")
        self.assertNotIn("不应出现在错误信息中", str(raised.exception))
        self.assertEqual(self._count("contact", owner_id), 0)
        self.assertEqual(self._count("source_document", owner_id), 0)
        self.assertEqual(self._count("message", owner_id), 0)

    def test_non_active_duplicate_source_requires_explicit_resolution(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        first = self.repository.import_document(owner_id=owner_id, document=self.batch)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.source_document SET status = 'deleted' WHERE id = %s",
                (first.source_document_id,),
            )

        with self.assertRaises(SourceStateConflictError):
            self.repository.import_document(owner_id=owner_id, document=self.batch)

        self.assertEqual(self._count("source_document", owner_id), 1)
        self.assertEqual(self._count("message", owner_id), 6)

    def test_same_contact_id_is_isolated_between_owners(self) -> None:
        first_owner = self._create_owner("合成用户甲")
        second_owner = self._create_owner("合成用户乙")

        self.repository.import_document(owner_id=first_owner, document=self.batch)
        self.repository.import_document(owner_id=second_owner, document=self.batch)

        self.assertEqual(self._count("contact", first_owner), 1)
        self.assertEqual(self._count("contact", second_owner), 1)
        self.assertEqual(self._count("source_document", first_owner), 1)
        self.assertEqual(self._count("source_document", second_owner), 1)
        self.assertEqual(
            self._scalar(
                "SELECT count(*) FROM public.message WHERE owner_id = %s",
                (first_owner,),
            ),
            6,
        )
        self.assertEqual(
            self._scalar(
                "SELECT count(*) FROM public.message WHERE owner_id = %s",
                (second_owner,),
            ),
            6,
        )

    def test_overlap_unique_constraint_exists(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            constraint = connection.execute(
                """
                SELECT pg_get_constraintdef(oid)
                FROM pg_constraint
                WHERE conrelid = 'public.message'::regclass
                  AND conname = 'message_contact_external_local_id_unique'
                """
            ).fetchone()

        self.assertIsNotNone(constraint)
        self.assertEqual(
            constraint[0],
            "UNIQUE (owner_id, contact_id, external_local_id)",
        )

    @staticmethod
    def _load_batch() -> ImportBatch:
        document = read_jsonl(FIXTURES_DIR / "valid_single_contact.jsonl")
        return normalize_document(document)

    def _create_owner(self, display_name: str) -> UUID:
        owner_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (owner_id, display_name),
            )
        self.owner_ids.add(owner_id)
        return owner_id

    @staticmethod
    def _count(table_name: str, owner_id: UUID) -> int:
        allowed_tables = {"owner", "contact", "source_document", "message"}
        if table_name not in allowed_tables:
            raise ValueError("不允许查询未知表。")
        owner_column = "id" if table_name == "owner" else "owner_id"
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            return connection.execute(
                f"SELECT count(*) FROM public.{table_name} "
                f"WHERE {owner_column} = %s",
                (owner_id,),
            ).fetchone()[0]

    @staticmethod
    def _scalar(query: str, parameters: tuple[object, ...]) -> object:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            return connection.execute(query, parameters).fetchone()[0]


if __name__ == "__main__":
    unittest.main()
