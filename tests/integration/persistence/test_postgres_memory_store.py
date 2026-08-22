"""PostgreSQL MemoryPort 和已确认记忆检索的联系人范围集成测试。"""

from __future__ import annotations

import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg

from notalone.memory import (
    AdoptionMethod,
    ConfirmedMemoryStatus,
    MemoryCandidate,
    MemoryCandidateStatus,
    MemoryCategory,
)
from notalone.persistence import (
    MemoryPersistenceError,
    PostgresMemoryStore,
    PostgresRetrieval,
)
from notalone.retrieval import RetrievalError
from notalone.scopes import ContactScope


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class PostgresMemoryStoreTest(unittest.TestCase):
    """只使用合成 owner、联系人和来源。"""

    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
                has_table = connection.execute(
                    "SELECT to_regclass('public.memory_candidate')"
                ).fetchone()[0]
        except psycopg.OperationalError as error:
            raise unittest.SkipTest(
                "本地 PostgreSQL 测试库不可用。"
            ) from error

        if not database_name.endswith("_test"):
            raise RuntimeError(
                "集成测试只允许连接名称以 _test 结尾的数据库。"
            )
        if has_table is None:
            raise unittest.SkipTest("测试库尚未应用 009 Memory 迁移。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        self.other_contact_id = uuid4()
        self.other_owner_id = uuid4()
        self.other_owner_contact_id = uuid4()
        self.source_id = uuid4()
        self.other_contact_source_id = uuid4()
        self.other_source_id = uuid4()
        self.candidate_id = uuid4()
        self.other_candidate_id = uuid4()
        self.invalidated_candidate_id = uuid4()

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            with connection.cursor() as cursor:
                cursor.executemany(
                    "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                    (
                        (self.owner_id, "合成记忆用户"),
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
                )
            self._insert_source(connection, self.source_id, "a")
            self._insert_source(
                connection,
                self.other_contact_source_id,
                "c",
                contact_id=self.other_contact_id,
            )
            self._insert_source(
                connection,
                self.other_source_id,
                "b",
                owner_id=self.other_owner_id,
                contact_id=self.other_owner_contact_id,
            )

        self.store = PostgresMemoryStore(TEST_DATABASE_URL)
        self.retrieval = PostgresRetrieval(TEST_DATABASE_URL)

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
            VALUES (%s, %s, %s, 'wechat_jsonl', %s, %s, 1, 'active')
            """,
            (
                source_id,
                owner_id or self.owner_id,
                contact_id or self.contact_id,
                f"synthetic-memory-{digest_letter}.jsonl",
                digest_letter * 64,
            ),
        )

    def _candidate(
        self,
        *,
        candidate_id: UUID | None = None,
        scope: ContactScope | None = None,
        source_ids: tuple[UUID, ...] | None = None,
        text: str = "对方喜欢徒步",
        category: MemoryCategory = MemoryCategory.PREFERENCE,
    ) -> MemoryCandidate:
        return MemoryCandidate(
            candidate_id=candidate_id or self.candidate_id,
            scope=scope or self._scope(),
            text=text,
            category=category,
            source_ids=source_ids or (self.source_id,),
        )

    def test_pending_candidate_is_not_retrieved_until_confirmed(self) -> None:
        candidate = self.store.create_candidate(self._candidate())

        self.assertEqual(candidate.status, MemoryCandidateStatus.PENDING)
        self.assertEqual(
            self.retrieval.search_confirmed_memories(scope=self._scope()),
            (),
        )

        confirmed = self.store.confirm(
            scope=self._scope(),
            candidate_id=candidate.candidate_id,
            adoption_method=AdoptionMethod.MANUAL,
        )
        self.assertEqual(confirmed.text, "对方喜欢徒步")
        self.assertEqual(confirmed.adoption_method, AdoptionMethod.MANUAL)
        found = self.retrieval.search_confirmed_memories(scope=self._scope())
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].source_ids, (self.source_id,))

        replayed = self.store.confirm(
            scope=self._scope(),
            candidate_id=candidate.candidate_id,
        )
        self.assertEqual(replayed.memory_id, confirmed.memory_id)

    def test_correction_invalidation_and_deletion_change_later_retrieval(self) -> None:
        self.store.create_candidate(self._candidate())
        confirmed = self.store.confirm(
            scope=self._scope(),
            candidate_id=self.candidate_id,
        )

        corrected = self.store.correct(
            scope=self._scope(),
            memory_id=confirmed.memory_id,
            text="对方最近喜欢城市徒步",
            category=MemoryCategory.RECENT_STATE,
        )
        self.assertEqual(corrected.revision, confirmed.revision + 1)
        self.assertEqual(
            self.retrieval.search_confirmed_memories(scope=self._scope())[0].text,
            "对方最近喜欢城市徒步",
        )

        invalidated = self.store.invalidate(
            scope=self._scope(),
            memory_id=confirmed.memory_id,
        )
        self.assertEqual(invalidated.status, ConfirmedMemoryStatus.INVALIDATED)
        self.assertEqual(
            self.retrieval.search_confirmed_memories(scope=self._scope()),
            (),
        )

        deleted = self.store.delete(
            scope=self._scope(),
            memory_id=confirmed.memory_id,
        )
        self.assertEqual(deleted.status, ConfirmedMemoryStatus.DELETED)

    def test_rejected_and_invalidated_candidates_cannot_be_confirmed(self) -> None:
        self.store.create_candidate(self._candidate())
        rejected = self.store.reject_candidate(
            scope=self._scope(),
            candidate_id=self.candidate_id,
        )
        self.assertEqual(rejected.status, MemoryCandidateStatus.REJECTED)
        with self.assertRaises(RuntimeError):
            self.store.confirm(scope=self._scope(), candidate_id=self.candidate_id)

        self.store.create_candidate(
            self._candidate(candidate_id=self.invalidated_candidate_id)
        )
        invalidated = self.store.invalidate_candidate(
            scope=self._scope(),
            candidate_id=self.invalidated_candidate_id,
        )
        self.assertEqual(invalidated.status, MemoryCandidateStatus.INVALIDATED)
        with self.assertRaises(RuntimeError):
            self.store.confirm(
                scope=self._scope(),
                candidate_id=self.invalidated_candidate_id,
            )

    def test_scope_is_checked_for_candidates_memories_and_retrieval(self) -> None:
        other_scope = self._scope(self.other_contact_id)
        self.store.create_candidate(
            self._candidate(
                scope=other_scope,
                source_ids=(self.other_contact_source_id,),
            )
        )
        with self.assertRaises(PermissionError):
            self.store.confirm(
                scope=self._scope(),
                candidate_id=self.candidate_id,
            )
        with self.assertRaises(PermissionError):
            self.store.create_candidate(
                self._candidate(
                    candidate_id=uuid4(),
                    source_ids=(self.other_source_id,),
                )
            )
        with self.assertRaises(LookupError):
            self.store.confirm(scope=self._scope(), candidate_id=uuid4())
        self.assertEqual(
            self.retrieval.search_confirmed_memories(scope=self._scope()),
            (),
        )

    def test_inactive_source_removes_memory_from_retrieval(self) -> None:
        self.store.create_candidate(self._candidate())
        confirmed = self.store.confirm(
            scope=self._scope(),
            candidate_id=self.candidate_id,
        )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                """
                UPDATE public.source_document
                SET status = 'delete_failed', deleted_at = NULL
                WHERE owner_id = %s AND contact_id = %s AND id = %s
                """,
                (self.owner_id, self.contact_id, self.source_id),
            )

        self.assertEqual(
            self.retrieval.search_confirmed_memories(scope=self._scope()),
            (),
        )
        self.assertEqual(confirmed.source_ids, (self.source_id,))

    def test_validity_window_controls_retrieval(self) -> None:
        self.store.create_candidate(self._candidate())
        confirmed = self.store.confirm(
            scope=self._scope(),
            candidate_id=self.candidate_id,
        )
        now = datetime.now(timezone.utc)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                """
                UPDATE public.confirmed_memory
                SET valid_at = %s, invalid_at = %s
                WHERE owner_id = %s AND contact_id = %s AND id = %s
                """,
                (
                    now + timedelta(days=1),
                    now + timedelta(days=3),
                    self.owner_id,
                    self.contact_id,
                    confirmed.memory_id,
                ),
            )

        self.assertEqual(
            self.retrieval.search_confirmed_memories(scope=self._scope()),
            (),
        )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                """
                UPDATE public.confirmed_memory
                SET valid_at = %s, invalid_at = %s
                WHERE owner_id = %s AND contact_id = %s AND id = %s
                """,
                (
                    now - timedelta(days=1),
                    now + timedelta(days=1),
                    self.owner_id,
                    self.contact_id,
                    confirmed.memory_id,
                ),
            )
        self.assertEqual(
            self.retrieval.search_confirmed_memories(scope=self._scope())[0].memory_id,
            confirmed.memory_id,
        )

    def test_duplicate_candidate_is_rejected(self) -> None:
        candidate = self._candidate()
        self.store.create_candidate(candidate)
        with self.assertRaises(ValueError):
            self.store.create_candidate(candidate)

    def test_database_failure_is_exposed_as_stable_errors(self) -> None:
        with patch(
            "notalone.persistence.memory_store.psycopg.connect",
            side_effect=psycopg.OperationalError("synthetic memory detail"),
        ):
            with self.assertRaises(MemoryPersistenceError) as memory_error:
                self.store.list_confirmed(self._scope())
        self.assertEqual(
            str(memory_error.exception),
            "关系记忆数据库操作失败。",
        )

        with patch(
            "notalone.persistence.memory_store.psycopg.connect",
            side_effect=psycopg.OperationalError("synthetic retrieval detail"),
        ):
            with self.assertRaises(RetrievalError) as retrieval_error:
                self.retrieval.search_confirmed_memories(scope=self._scope())
        self.assertEqual(str(retrieval_error.exception), "关系记忆检索失败。")


if __name__ == "__main__":
    unittest.main()
